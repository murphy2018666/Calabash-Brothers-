import { Test } from '@nestjs/testing';
import {
  PRINCIPAL_REPOSITORY,
  type PrincipalRepository,
  type PrincipalRecord,
} from '@aegisci/domain/identity';
import { InMemoryPrincipalRepository } from './in-memory-principal-repository';

/**
 * InMemoryPrincipalRepository 单元测试（F1-1 端口实现）。
 *
 * 覆盖端口契约不变量：
 * - read-your-writes：save() 后 findById() 必命中
 * - delete() 返回是否存在；不存在返回 false
 * - 多租户隔离：findByType(type, tenantId) 不跨租户返回
 * - 写入冻结：save() 返回的对象 Object.isFrozen() === true
 * - agentCardId 反向索引：findByAgentCard() 命中 / 删除时清索引
 * - tenant+type 索引：findByType(type, tenantId) 走快路径
 */
describe('InMemoryPrincipalRepository (F1-1 端口实现)', () => {
  let repo: InMemoryPrincipalRepository;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        InMemoryPrincipalRepository,
        {
          provide: PRINCIPAL_REPOSITORY,
          useExisting: InMemoryPrincipalRepository,
        },
      ],
    }).compile();
    repo = moduleRef.get(InMemoryPrincipalRepository);
    repo.clear();
  });

  describe('save() / findById() — read-your-writes', () => {
    it('returns a frozen record after save()', async () => {
      const record = makeRecord({ id: 'p-1', type: 'user', tenantId: 't1' });
      const saved = await repo.save(record);
      expect(Object.isFrozen(saved)).toBe(true);
      expect(saved.id).toBe('p-1');
    });

    it('findById() returns the saved record immediately', async () => {
      const record = makeRecord({ id: 'p-1', type: 'user', tenantId: 't1' });
      await repo.save(record);
      const found = await repo.findById('p-1');
      expect(found).not.toBeNull();
      expect(found?.id).toBe('p-1');
    });

    it('findById() returns null for unknown id', async () => {
      const found = await repo.findById('unknown');
      expect(found).toBeNull();
    });

    it('save() on existing id overwrites the record', async () => {
      const record = makeRecord({
        id: 'p-1',
        type: 'user',
        tenantId: 't1',
        displayName: 'Old',
      });
      await repo.save(record);
      await repo.save({ ...record, displayName: 'New' });
      const found = await repo.findById('p-1');
      expect(found?.displayName).toBe('New');
    });
  });

  describe('findByTenant()', () => {
    beforeEach(async () => {
      await repo.save(makeRecord({ id: 'p-1', type: 'user', tenantId: 't1' }));
      await repo.save(makeRecord({ id: 'p-2', type: 'user', tenantId: 't1' }));
      await repo.save(makeRecord({ id: 'p-3', type: 'user', tenantId: 't2' }));
    });

    it('returns only principals in the given tenant', async () => {
      const list = await repo.findByTenant('t1');
      expect(list).toHaveLength(2);
      expect(list.every((p) => p.tenantId === 't1')).toBe(true);
    });

    it('returns [] for a tenant with no principals', async () => {
      const list = await repo.findByTenant('t-empty');
      expect(list).toEqual([]);
    });
  });

  describe('findByType()', () => {
    beforeEach(async () => {
      await repo.save(makeRecord({ id: 'p-u1', type: 'user', tenantId: 't1' }));
      await repo.save(makeRecord({ id: 'p-u2', type: 'user', tenantId: 't2' }));
      await repo.save(
        makeRecord({ id: 'p-s1', type: 'service', tenantId: 't1' }),
      );
      await repo.save(
        makeRecord({ id: 'p-a1', type: 'agent', tenantId: 't1' }),
      );
    });

    it('returns all principals of the given type (no tenant filter)', async () => {
      const users = await repo.findByType('user');
      expect(users).toHaveLength(2);
      expect(users.every((p) => p.type === 'user')).toBe(true);
    });

    it('scopes by tenantId when provided (uses fast index path)', async () => {
      const t1Users = await repo.findByType('user', 't1');
      expect(t1Users).toHaveLength(1);
      expect(t1Users[0].id).toBe('p-u1');
    });

    it('does not cross tenants when tenantId is provided', async () => {
      const t2Users = await repo.findByType('user', 't2');
      expect(t2Users).toHaveLength(1);
      expect(t2Users[0].tenantId).toBe('t2');
    });

    it('returns [] when tenant has no principals of the type', async () => {
      const list = await repo.findByType('agent', 't2');
      expect(list).toEqual([]);
    });
  });

  describe('findByAgentCard()', () => {
    it('returns the principal linked to the agentCardId', async () => {
      const record = makeRecord({
        id: 'p-a1',
        type: 'agent',
        tenantId: 't1',
        agentCardId: 'agent-card-1',
      });
      await repo.save(record);
      const found = await repo.findByAgentCard('agent-card-1');
      expect(found).not.toBeNull();
      expect(found?.id).toBe('p-a1');
    });

    it('returns null for an unknown agentCardId', async () => {
      const found = await repo.findByAgentCard('unknown');
      expect(found).toBeNull();
    });

    it('clears the reverse index when the principal is deleted', async () => {
      const record = makeRecord({
        id: 'p-a1',
        type: 'agent',
        tenantId: 't1',
        agentCardId: 'agent-card-1',
      });
      await repo.save(record);
      await repo.delete('p-a1');
      const found = await repo.findByAgentCard('agent-card-1');
      expect(found).toBeNull();
    });

    it('updates the reverse index when agentCardId changes', async () => {
      const record = makeRecord({
        id: 'p-a1',
        type: 'agent',
        tenantId: 't1',
        agentCardId: 'card-old',
      });
      await repo.save(record);
      await repo.save({ ...record, agentCardId: 'card-new' });
      expect(await repo.findByAgentCard('card-old')).toBeNull();
      const found = await repo.findByAgentCard('card-new');
      expect(found?.id).toBe('p-a1');
    });
  });

  describe('delete()', () => {
    it('returns true when deleting an existing record', async () => {
      const record = makeRecord({ id: 'p-1', type: 'user', tenantId: 't1' });
      await repo.save(record);
      const result = await repo.delete('p-1');
      expect(result).toBe(true);
      expect(await repo.findById('p-1')).toBeNull();
    });

    it('returns false when deleting a non-existent record', async () => {
      const result = await repo.delete('unknown');
      expect(result).toBe(false);
    });

    it('cleans up tenant+type index on delete', async () => {
      const record = makeRecord({
        id: 'p-1',
        type: 'user',
        tenantId: 't1',
      });
      await repo.save(record);
      await repo.delete('p-1');
      const list = await repo.findByType('user', 't1');
      expect(list).toEqual([]);
    });
  });

  describe('DI — provider wiring via PRINCIPAL_REPOSITORY token', () => {
    it('is injectable via PRINCIPAL_REPOSITORY token (useExisting pattern)', async () => {
      const moduleRef = await Test.createTestingModule({
        providers: [
          InMemoryPrincipalRepository,
          {
            provide: PRINCIPAL_REPOSITORY,
            useExisting: InMemoryPrincipalRepository,
          },
        ],
      }).compile();
      const fromToken = moduleRef.get<PrincipalRepository>(
        PRINCIPAL_REPOSITORY,
      );
      expect(fromToken).toBeInstanceOf(InMemoryPrincipalRepository);
    });
  });

  describe('healthy() / size() / clear() — 测试用工具', () => {
    it('healthy() returns true for the in-memory stub', async () => {
      expect(await repo.healthy()).toBe(true);
    });

    it('size() reflects the number of stored records', async () => {
      expect(repo.size()).toBe(0);
      await repo.save(makeRecord({ id: 'p-1', type: 'user', tenantId: 't1' }));
      await repo.save(makeRecord({ id: 'p-2', type: 'user', tenantId: 't1' }));
      expect(repo.size()).toBe(2);
    });

    it('clear() empties all indexes', async () => {
      await repo.save(
        makeRecord({
          id: 'p-1',
          type: 'agent',
          tenantId: 't1',
          agentCardId: 'card-1',
        }),
      );
      repo.clear();
      expect(repo.size()).toBe(0);
      expect(await repo.findByAgentCard('card-1')).toBeNull();
      expect(await repo.findByType('agent', 't1')).toEqual([]);
    });
  });
});

function makeRecord(overrides: Partial<PrincipalRecord>): PrincipalRecord {
  const now = new Date().toISOString();
  return {
    id: overrides.id ?? 'p-x',
    type: overrides.type ?? 'user',
    tenantId: overrides.tenantId ?? 't-default',
    roles: overrides.roles ?? [],
    createdAt: overrides.createdAt ?? now,
    updatedAt: overrides.updatedAt ?? now,
    displayName: overrides.displayName ?? 'Test Principal',
    agentCardId: overrides.agentCardId,
    capabilities: overrides.capabilities,
  };
}
