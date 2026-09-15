import { Test } from '@nestjs/testing';
import type { AgentCard } from '@aegisci/shared/types';
import { IdentityService } from './identity.service';
import { PRINCIPAL_REPOSITORY } from './identity.module';
import type {
  PrincipalRecord,
  PrincipalRepository,
} from './identity.module';

/**
 * IdentityService 单元测试（F1-1 三元主体完整建模）。
 *
 * 覆盖：
 * - 三类主体注册（User/Service/Agent）
 * - Agent 主体与 AgentCard 单向绑定
 * - 查询：按 ID / 按 tenant / 按 type / 按 agentCardId
 * - 更新（roles / displayName；不可变字段 id/createdAt/type/tenantId/agentCardId）
 * - 删除
 * - read-your-writes 一致性
 */
describe('IdentityService (F1-1 三元主体完整建模)', () => {
  let service: IdentityService;
  let repo: PrincipalRepository;

  beforeEach(async () => {
    // IdentityService 仅依赖 PRINCIPAL_REPOSITORY；直接声明避免引入
    // IdentityModule 内 TokenService 的 AGENT_TOKEN_REGISTRY/EventEmitter2 依赖
    // （两者由控制面装配，域内单元测试无需引入）。
    repo = createMockRepo();
    const moduleRef = await Test.createTestingModule({
      providers: [
        IdentityService,
        { provide: PRINCIPAL_REPOSITORY, useValue: repo },
      ],
    }).compile();

    service = moduleRef.get(IdentityService);
  });

  describe('register() 通用入口（向后兼容 S1 签名）', () => {
    it('registers a principal of any type and returns a frozen record', async () => {
      const record = await service.register(
        'user',
        'tenant-1',
        ['viewer'],
        'Alice',
      );
      expect(record.id).toMatch(/^[0-9a-f-]{36}$/);
      expect(record.type).toBe('user');
      expect(record.tenantId).toBe('tenant-1');
      expect(record.roles).toEqual(['viewer']);
      expect(record.displayName).toBe('Alice');
      expect(record.createdAt).toBe(record.updatedAt);
      expect(Object.isFrozen(record)).toBe(true);
    });
  });

  describe('registerUser() / registerServiceAccount()', () => {
    it('registers a user with type=user', async () => {
      const user = await service.registerUser(
        'tenant-1',
        ['viewer'],
        'Bob',
      );
      expect(user.type).toBe('user');
    });

    it('registers a service account with type=service', async () => {
      const svc = await service.registerServiceAccount(
        'tenant-1',
        ['runner'],
        'ci-runner',
      );
      expect(svc.type).toBe('service');
    });
  });

  describe('registerAgent() 与 AgentCard 绑定', () => {
    const card: AgentCard = {
      agentId: 'agent-card-1',
      role: 'reviewer',
      displayName: 'Reviewer Agent',
      modelId: 'gpt-4',
      capabilities: ['code.review', 'comment'],
      riskTier: 'G2',
      tenantId: 'tenant-1',
    };

    it('registers an agent with type=agent and links to AgentCard', async () => {
      const agent = await service.registerAgent(card);
      expect(agent.type).toBe('agent');
      expect(agent.agentCardId).toBe('agent-card-1');
      expect(agent.capabilities).toEqual(['code.review', 'comment']);
      expect(agent.roles).toEqual(['agent:reviewer']);
      expect(agent.displayName).toBe('Reviewer Agent');
    });

    it('finds the principal via findByAgentCard(agentCardId)', async () => {
      const registered = await service.registerAgent(card);
      const found = await service.findByAgentCard(card.agentId);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(registered.id);
    });

    it('returns null for an unknown agentCardId', async () => {
      const found = await service.findByAgentCard('unknown-agent');
      expect(found).toBeNull();
    });
  });

  describe('lookup()', () => {
    it('returns null for an unknown ID', async () => {
      const found = await service.lookup('unknown-id');
      expect(found).toBeNull();
    });

    it('returns the record by ID after register()', async () => {
      const registered = await service.registerUser(
        'tenant-1',
        ['viewer'],
        'Carol',
      );
      const found = await service.lookup(registered.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(registered.id);
    });

    it('satisfies read-your-writes: findById() hits immediately after save()', async () => {
      const record = await service.registerUser(
        'tenant-1',
        ['viewer'],
        'Dan',
      );
      const fromRepo = await repo.findById(record.id);
      expect(fromRepo).not.toBeNull();
      expect(fromRepo?.id).toBe(record.id);
    });
  });

  describe('listByTenant() / listByType()', () => {
    beforeEach(async () => {
      await service.registerUser('tenant-A', ['viewer'], 'User1');
      await service.registerUser('tenant-A', ['viewer'], 'User2');
      await service.registerUser('tenant-B', ['viewer'], 'User3');
      await service.registerServiceAccount('tenant-A', ['runner'], 'Svc1');
    });

    it('listByTenant() returns only principals from that tenant', async () => {
      const list = await service.listByTenant('tenant-A');
      expect(list).toHaveLength(3);
      expect(list.every((p) => p.tenantId === 'tenant-A')).toBe(true);
    });

    it('listByType() returns principals of a given type (across tenants when tenantId omitted)', async () => {
      const users = await service.listByType('user');
      expect(users).toHaveLength(3);
      expect(users.every((p) => p.type === 'user')).toBe(true);
    });

    it('listByType(type, tenantId) scopes by tenant', async () => {
      const tenantAUsers = await service.listByType('user', 'tenant-A');
      expect(tenantAUsers).toHaveLength(2);
      expect(
        tenantAUsers.every((p) => p.tenantId === 'tenant-A'),
      ).toBe(true);
    });

    it('listByType() does not cross tenants when tenantId is specified', async () => {
      const tenantBUsers = await service.listByType('user', 'tenant-B');
      expect(tenantBUsers).toHaveLength(1);
      expect(tenantBUsers[0].tenantId).toBe('tenant-B');
    });
  });

  describe('update()', () => {
    it('updates roles and displayName and bumps updatedAt', async () => {
      const original = await service.registerUser(
        'tenant-1',
        ['viewer'],
        'Eve',
      );
      // 确保 updatedAt 严格递增
      await new Promise((r) => setTimeout(r, 5));
      const updated = await service.update(original.id, {
        roles: ['viewer', 'approver'],
        displayName: 'Eve Updated',
      });
      expect(updated.roles).toEqual(['viewer', 'approver']);
      expect(updated.displayName).toBe('Eve Updated');
      expect(updated.updatedAt).not.toBe(original.updatedAt);
      // 不可变字段保持
      expect(updated.id).toBe(original.id);
      expect(updated.createdAt).toBe(original.createdAt);
      expect(updated.type).toBe(original.type);
      expect(updated.tenantId).toBe(original.tenantId);
    });

    it('throws when principal not found', async () => {
      await expect(
        service.update('unknown', { roles: ['x'] }),
      ).rejects.toThrow(/principal not found/);
    });
  });

  describe('delete()', () => {
    it('deletes an existing principal and returns true', async () => {
      const r = await service.registerUser('tenant-1', ['viewer'], 'Frank');
      const deleted = await service.delete(r.id);
      expect(deleted).toBe(true);
      const found = await service.lookup(r.id);
      expect(found).toBeNull();
    });

    it('returns false for unknown ID', async () => {
      const deleted = await service.delete('unknown');
      expect(deleted).toBe(false);
    });

    it('cleans up agentCardId reverse index on delete', async () => {
      const card: AgentCard = {
        agentId: 'agent-delete-1',
        role: 'reviewer',
        displayName: 'Reviewer',
        modelId: 'm',
        capabilities: [],
        riskTier: 'G2',
        tenantId: 'tenant-1',
      };
      const agent = await service.registerAgent(card);
      await service.delete(agent.id);
      const byCard = await service.findByAgentCard(card.agentId);
      expect(byCard).toBeNull();
    });
  });
});

/** 创建内存 PrincipalRepository 桩（与 IdentityModule 内置实现同语义）。 */
function createMockRepo(): PrincipalRepository {
  const store = new Map<string, PrincipalRecord>();
  const byAgentCard = new Map<string, string>();
  return {
    async save(record) {
      const frozen: PrincipalRecord = Object.freeze({ ...record });
      store.set(record.id, frozen);
      if (record.agentCardId) byAgentCard.set(record.agentCardId, record.id);
      return frozen;
    },
    async findById(id) {
      return store.get(id) ?? null;
    },
    async findByTenant(tenantId) {
      return [...store.values()].filter((p) => p.tenantId === tenantId);
    },
    async findByType(type, tenantId) {
      return [...store.values()].filter(
        (p) =>
          p.type === type && (tenantId === undefined || p.tenantId === tenantId),
      );
    },
    async findByAgentCard(agentCardId) {
      const id = byAgentCard.get(agentCardId);
      return id ? (store.get(id) ?? null) : null;
    },
    async delete(id) {
      const existing = store.get(id);
      if (!existing) return false;
      if (existing.agentCardId) byAgentCard.delete(existing.agentCardId);
      return store.delete(id);
    },
  };
}
