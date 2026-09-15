import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { UnauthorizedException } from '@nestjs/common';
import type { AgentCard } from '@aegisci/shared/types';
import { OidcProviderService } from './oidc-provider.service';
import { IdentityService } from './identity.service';
import {
  AGENT_TOKEN_REGISTRY,
  TokenService,
  type AgentTokenRegistry,
} from './token.service';
import { PRINCIPAL_REPOSITORY } from './identity.module';
import type {
  PrincipalRecord,
  PrincipalRepository,
} from './identity.module';

const TEST_TOKEN_SIGNING_SECRET = 'test-signing-secret-for-oidc-spec-only';

/**
 * OidcProviderService 单元测试（F1-3 OIDC Provider 骨架）。
 *
 * 覆盖：
 * - discovery() 返回符合 OIDC Discovery 形状的元数据
 * - token() authorization_code 流：校验 code、签发 JWT
 * - token() 错误路径：unsupported grant_type / 缺失 code / 无对应 Principal
 * - userInfo() 校验 Bearer 令牌后返回 Principal 摘要
 * - userInfo() 错误路径：令牌无效 / 无对应 Principal
 * - extractBearerToken() 工具方法
 */
describe('OidcProviderService (F1-3 OIDC Provider 骨架)', () => {
  let service: OidcProviderService;
  let identity: IdentityService;
  let tokens: TokenService;
  let events: EventEmitter2;

  const card: AgentCard = {
    agentId: 'agent-oidc-1',
    role: 'reviewer',
    displayName: 'Reviewer Agent',
    modelId: 'm',
    capabilities: ['code.review', 'comment'],
    riskTier: 'G2',
    tenantId: 'tenant-1',
  };

  beforeEach(async () => {
    process.env.AEGISCI_TOKEN_SIGNING_SECRET = TEST_TOKEN_SIGNING_SECRET;
    events = new EventEmitter2();
    // 直接声明服务与其端口 mock：AGENT_TOKEN_REGISTRY/EventEmitter2 由控制面装配，
    // IdentityModule 图内不存在（overrideProvider 对图中不存在的 token 是空操作）。
    const moduleRef = await Test.createTestingModule({
      providers: [
        OidcProviderService,
        IdentityService,
        TokenService,
        { provide: PRINCIPAL_REPOSITORY, useValue: createMockRepo() },
        { provide: AGENT_TOKEN_REGISTRY, useValue: createMockRegistry() },
        { provide: EventEmitter2, useValue: events },
      ],
    }).compile();

    service = moduleRef.get(OidcProviderService);
    identity = moduleRef.get(IdentityService);
    tokens = moduleRef.get(TokenService);
  });

  describe('discovery() — GET /.well-known/openid-configuration', () => {
    it('returns a spec-conformant discovery document', async () => {
      const doc = await service.discovery();
      expect(doc.issuer).toMatch(/^https?:\/\//);
      expect(doc.authorization_endpoint).toContain('/authorize');
      expect(doc.token_endpoint).toContain('/token');
      expect(doc.userinfo_endpoint).toContain('/userinfo');
      expect(doc.jwks_uri).toContain('/jwks');
      expect(doc.response_types_supported).toContain('code');
      expect(doc.grant_types_supported).toContain('authorization_code');
      expect(doc.id_token_signing_alg_values_supported).toContain('HS256');
      expect(doc.scopes_supported).toContain('openid');
      expect(doc.claims_supported).toContain('sub');
    });
  });

  describe('token() — POST /token (authorization_code)', () => {
    beforeEach(async () => {
      // 预注册 AgentCard 对应的 Principal
      await identity.registerAgent(card);
    });

    it('issues a Bearer JWT for a valid authorization_code', async () => {
      const resp = await service.token({
        grant_type: 'authorization_code',
        code: card.agentId, // 骨架阶段：code = agentId
        redirect_uri: 'https://app.local/cb',
      });
      expect(resp.token_type).toBe('Bearer');
      expect(resp.access_token.split('.')).toHaveLength(3); // JWT shape
      expect(resp.expires_in).toBeGreaterThan(0);
      expect(resp.expires_in).toBeLessThanOrEqual(30 * 60);
      expect(resp.scope).toContain('code.review');
      expect(resp.jti).toMatch(/^[0-9a-f-]{36}$/);
    });

    it('emits OidcTokenIssued event on success', async () => {
      const handler = jest.fn();
      events.on('OidcTokenIssued', handler);
      await service.token({
        grant_type: 'authorization_code',
        code: card.agentId,
        redirect_uri: 'https://app.local/cb',
      });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          agentCardId: card.agentId,
        }),
      );
    });

    it('rejects unsupported grant_type with 401 invalid_grant', async () => {
      await expect(
        service.token({
          grant_type: 'client_credentials',
          code: card.agentId,
          redirect_uri: 'https://app.local/cb',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when code and redirect_uri are missing', async () => {
      await expect(
        service.token({ grant_type: 'authorization_code' }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });

    it('rejects when no principal is linked to the code (invalid_grant)', async () => {
      await expect(
        service.token({
          grant_type: 'authorization_code',
          code: 'unregistered-agent',
          redirect_uri: 'https://app.local/cb',
        }),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    });
  });

  describe('userInfo() — GET /userinfo', () => {
    beforeEach(async () => {
      await identity.registerAgent(card);
    });

    it('returns principal summary for a valid Bearer token', async () => {
      const t = await tokens.issueAgentToken(card);
      const info = await service.userInfo(t.token);
      expect(info.agent_id).toBe(card.agentId);
      expect(info.principal_type).toBe('agent');
      expect(info.tenant_id).toBe(card.tenantId);
      expect(info.name).toBe(card.displayName);
      expect(info.capabilities).toEqual(card.capabilities);
      expect(info.jti).toBe(t.jti);
    });

    it('rejects an invalid (non-JWT) token with 401', async () => {
      await expect(service.userInfo('not-a-jwt')).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects a token with no linked principal', async () => {
      // 签发一个 principalId 未关联的 token：使用一个未注册的 AgentCard
      const unregisteredCard: AgentCard = {
        ...card,
        agentId: 'orphan-agent',
      };
      const t = await tokens.issueAgentToken(unregisteredCard);
      await expect(service.userInfo(t.token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('extractBearerToken() — Authorization 头解析', () => {
    it('returns the token for a valid Bearer header', () => {
      expect(
        service.extractBearerToken('Bearer abc.def.ghi'),
      ).toBe('abc.def.ghi');
    });

    it('returns the token for case-insensitive bearer prefix', () => {
      expect(
        service.extractBearerToken('bearer abc.def.ghi'),
      ).toBe('abc.def.ghi');
    });

    it('returns null for missing header', () => {
      expect(service.extractBearerToken(undefined)).toBeNull();
    });

    it('returns null for non-Bearer scheme', () => {
      expect(service.extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
    });

    it('returns null for empty token after prefix', () => {
      expect(service.extractBearerToken('Bearer ')).toBeNull();
    });
  });
});

function createMockRegistry(): AgentTokenRegistry {
  const entries = new Map<
    string,
    { agentId: string; revoked: boolean; expiresAt: string }
  >();
  return {
    async register(jti, entry) {
      entries.set(jti, {
        agentId: entry.agentId,
        revoked: false,
        expiresAt: entry.expiresAt,
      });
    },
    async revoke(jti) {
      const e = entries.get(jti);
      if (e) entries.set(jti, { ...e, revoked: true });
    },
    async listByAgent(agentId) {
      return [...entries.entries()]
        .filter(([, e]) => e.agentId === agentId && !e.revoked)
        .map(([jti]) => jti);
    },
    async isRevoked(jti) {
      return entries.get(jti)?.revoked ?? false;
    },
  };
}

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
