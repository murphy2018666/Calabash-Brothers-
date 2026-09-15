import { createHmac } from 'crypto';
import { Test } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AgentCard } from '@aegisci/shared/types';
import {
  AGENT_TOKEN_REGISTRY,
  MAX_TTL_SECONDS,
  TokenService,
  TokenVerificationError,
  type AgentTokenRegistry,
} from './token.service';

const TEST_SIGNING_SECRET = 'test-signing-secret-for-unit-tests-only';

/** 确保每个测试前环境变量干净（S13 补强：fail-fast 测试需先验证缺失时抛错）。 */
function resetEnv(): void {
  delete process.env.AEGISCI_TOKEN_SIGNING_SECRET;
}

function setEnvSecret(secret: string): void {
  process.env.AEGISCI_TOKEN_SIGNING_SECRET = secret;
}

/**
 * TokenService 单元测试（F1-2 Agent Token 签发深）。
 *
 * 覆盖：
 * - sign：JWT 形状、JTI、TTL ≤ 30min、capabilities 快照
 * - verify：解码 + 验签 + 验过期 + 验 JTI 吊销
 * - revokeAgentToken：按 JTI 单吊
 * - revokeAll：按 agentId 全吊
 * - 错误路径：INVALID_FORMAT / INVALID_SIGNATURE / EXPIRED / REVOKED
 */
describe('TokenService (F1-2 Agent Token 签发深)', () => {
  let service: TokenService;
  let registry: AgentTokenRegistry & {
    __entries: Map<string, { agentId: string; revoked: boolean; expiresAt: string }>;
  };

  const card: AgentCard = {
    agentId: 'agent-1',
    role: 'reviewer',
    displayName: 'Reviewer Agent',
    modelId: 'm',
    capabilities: ['code.review', 'comment'],
    riskTier: 'G2',
    tenantId: 'tenant-1',
  };

  beforeEach(async () => {
    resetEnv();
    setEnvSecret(TEST_SIGNING_SECRET);
    registry = createInMemoryRegistry() as typeof registry;
    const moduleRef = await Test.createTestingModule({
      providers: [
        TokenService,
        { provide: AGENT_TOKEN_REGISTRY, useValue: registry },
        EventEmitter2,
      ],
    }).compile();
    service = moduleRef.get(TokenService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S13 合规补强：fail-fast 校验（GB/T 22239-2019 8.3.5）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('S13-T-13-02: constructor throws when AEGISCI_TOKEN_SIGNING_SECRET is missing', async () => {
    resetEnv(); // 清除环境变量
    await expect(
      Test.createTestingModule({
        providers: [
          TokenService,
          { provide: AGENT_TOKEN_REGISTRY, useValue: createInMemoryRegistry() },
          EventEmitter2,
        ],
      }).compile(),
    ).rejects.toThrow(/AEGISCI_TOKEN_SIGNING_SECRET/);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // issueAgentToken() — sign
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('issueAgentToken() — sign', () => {
    it('issues a JWT with 3 segments (header.payload.signature)', async () => {
      const t = await service.issueAgentToken(card);
      expect(t.token.split('.')).toHaveLength(3);
      expect(t.jti).toMatch(/^[0-9a-f-]{36}$/);
      expect(t.agentId).toBe(card.agentId);
      expect(t.capabilities).toEqual(card.capabilities);
    });

    it('encodes HS256 alg in the header', async () => {
      const t = await service.issueAgentToken(card);
      const [headerB64] = t.token.split('.') as [string, string, string];
      const header = JSON.parse(
        Buffer.from(headerB64, 'base64url').toString('utf8'),
      );
      expect(header.alg).toBe('HS256');
      expect(header.typ).toBe('JWT');
    });

    it('respects MAX_TTL_SECONDS upper bound and truncates', async () => {
      const warn = jest.spyOn(service['logger'], 'warn').mockImplementation();
      const t = await service.issueAgentToken(card, {
        ttlSeconds: MAX_TTL_SECONDS + 60,
      });
      // 过期时间距现在必须 ≤ MAX_TTL_SECONDS 秒
      const ttl =
        (new Date(t.expiresAt).getTime() - Date.now()) / 1000;
      expect(ttl).toBeLessThanOrEqual(MAX_TTL_SECONDS);
      expect(ttl).toBeGreaterThan(MAX_TTL_SECONDS - 5);
      expect(warn).toHaveBeenCalled();
    });

    it('rejects zero / negative TTL', async () => {
      await expect(
        service.issueAgentToken(card, { ttlSeconds: 0 }),
      ).rejects.toThrow(/invalid TTL/);
      await expect(
        service.issueAgentToken(card, { ttlSeconds: -1 }),
      ).rejects.toThrow(/invalid TTL/);
    });

    it('capabilities is a snapshot (mutating card.capabilities after issue does not change token)', async () => {
      const cardCopy: AgentCard = {
        ...card,
        capabilities: ['code.review'],
      };
      const t = await service.issueAgentToken(cardCopy);
      cardCopy.capabilities.push('escalated.capability');
      const payload = decodeJwtPayload(t.token);
      expect(payload.capabilities).toEqual(['code.review']);
    });

    it('registers JTI in the registry for tracking', async () => {
      const t = await service.issueAgentToken(card);
      const active = await registry.listByAgent(card.agentId);
      expect(active).toContain(t.jti);
    });
  });

  describe('verify() — happy path', () => {
    it('verifies a freshly issued token and returns decoded claims', async () => {
      const t = await service.issueAgentToken(card);
      const verified = await service.verify(t.token);
      expect(verified.jti).toBe(t.jti);
      expect(verified.agentId).toBe(card.agentId);
      expect(verified.capabilities).toEqual(card.capabilities);
      expect(new Date(verified.issuedAt).getTime()).toBeLessThanOrEqual(
        Date.now(),
      );
      expect(new Date(verified.expiresAt).getTime()).toBeGreaterThan(
        Date.now(),
      );
    });
  });

  describe('verify() — error paths', () => {
    it('rejects non-JWT format (1 segment) with INVALID_FORMAT', async () => {
      await expect(service.verify('not-a-jwt')).rejects.toMatchObject({
        reason: 'INVALID_FORMAT',
      });
    });

    it('rejects tampered signature with INVALID_SIGNATURE', async () => {
      const t = await service.issueAgentToken(card);
      const [h, p] = t.token.split('.') as [string, string, string];
      const tampered = `${h}.${p}.a-base64url-fake-signature`;
      await expect(service.verify(tampered)).rejects.toMatchObject({
        reason: 'INVALID_SIGNATURE',
      });
    });

    it('rejects tampered payload with INVALID_SIGNATURE', async () => {
      const t = await service.issueAgentToken(card);
      const [h, , sig] = t.token.split('.') as [string, string, string];
      // 构造一个篡改的 payload（agentId 改为 attacker）
      const fakePayload = Buffer.from(
        JSON.stringify({
          iss: 'aegisci:identity',
          sub: 'attacker',
          jti: t.jti,
          capabilities: ['escalate'],
          iat: Math.floor(Date.now() / 1000),
          exp: Math.floor(Date.now() / 1000) + 3600,
        }),
      ).toString('base64url');
      const tampered = `${h}.${fakePayload}.${sig}`;
      await expect(service.verify(tampered)).rejects.toMatchObject({
        reason: 'INVALID_SIGNATURE',
      });
    });

    it('rejects expired tokens with EXPIRED', async () => {
      // 直接构造一个过期令牌（手工 sign，绕过 TTL 上限）
      const testSecret = 'test-secret-for-expired-token';
      const payload = {
        iss: 'aegisci:identity',
        sub: card.agentId,
        jti: 'expired-jti',
        capabilities: [],
        iat: Math.floor(Date.now() / 1000) - 3600,
        exp: Math.floor(Date.now() / 1000) - 60,
      };
      const expiredToken = signJwt(payload, testSecret);
      await expect(
        service.verify(expiredToken, { signingSecret: testSecret }),
      ).rejects.toMatchObject({
        reason: 'EXPIRED',
      });
    });

    it('rejects revoked tokens with REVOKED', async () => {
      const t = await service.issueAgentToken(card);
      await service.revokeAgentToken(t.jti);
      await expect(service.verify(t.token)).rejects.toMatchObject({
        reason: 'REVOKED',
      });
    });

    it('throws TokenVerificationError subclass for all error paths', async () => {
      await expect(service.verify('bad')).rejects.toBeInstanceOf(
        TokenVerificationError,
      );
    });
  });

  describe('revokeAgentToken() — single JTI revocation', () => {
    it('removes the JTI from the active list', async () => {
      const t = await service.issueAgentToken(card);
      await service.revokeAgentToken(t.jti);
      const active = await registry.listByAgent(card.agentId);
      expect(active).not.toContain(t.jti);
    });

    it('emits AgentTokenRevoked event', async () => {
      const events = new EventEmitter2();
      const moduleRef = await Test.createTestingModule({
        providers: [
          TokenService,
          { provide: AGENT_TOKEN_REGISTRY, useValue: registry },
          { provide: EventEmitter2, useValue: events },
        ],
      }).compile();
      const localService = moduleRef.get(TokenService);
      const t = await localService.issueAgentToken(card);
      const handler = jest.fn();
      events.on('AgentTokenRevoked', handler);
      await localService.revokeAgentToken(t.jti);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ jti: t.jti }),
      );
    });
  });

  describe('revokeAll() — by agentId', () => {
    it('revokes all tokens for an agent and returns the revoked JTIs', async () => {
      const t1 = await service.issueAgentToken(card);
      const t2 = await service.issueAgentToken(card);
      const t3 = await service.issueAgentToken(card);
      const revoked = await service.revokeAll(card.agentId);
      expect(revoked.sort()).toEqual(
        [t1.jti, t2.jti, t3.jti].sort(),
      );
      const active = await registry.listByAgent(card.agentId);
      expect(active).toEqual([]);
    });

    it('emits AgentTokensRevoked event when revoking', async () => {
      const events = new EventEmitter2();
      const moduleRef = await Test.createTestingModule({
        providers: [
          TokenService,
          { provide: AGENT_TOKEN_REGISTRY, useValue: registry },
          { provide: EventEmitter2, useValue: events },
        ],
      }).compile();
      const localService = moduleRef.get(TokenService);
      const t1 = await localService.issueAgentToken(card);
      await localService.issueAgentToken(card);
      const handler = jest.fn();
      events.on('AgentTokensRevoked', handler);
      await localService.revokeAll(card.agentId);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: card.agentId,
          jtis: expect.arrayContaining([t1.jti]),
        }),
      );
    });

    it('returns [] when no tokens exist for the agent', async () => {
      const revoked = await service.revokeAll('agent-without-tokens');
      expect(revoked).toEqual([]);
    });

    it('revokeAgent() alias delegates to revokeAll()', async () => {
      const t = await service.issueAgentToken(card);
      const revoked = await service.revokeAgent(card.agentId);
      expect(revoked).toEqual([t.jti]);
    });
  });

  describe('isRevoked() optional method fallback', () => {
    it('falls back to listByAgent when registry does not implement isRevoked', async () => {
      // 默认 mock registry 实现了 isRevoked —— 测试 fallback 路径需删除它
      const registryWithoutIsRevoked: AgentTokenRegistry = {
        register: registry.register,
        revoke: registry.revoke,
        listByAgent: registry.listByAgent,
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          TokenService,
          { provide: AGENT_TOKEN_REGISTRY, useValue: registryWithoutIsRevoked },
          EventEmitter2,
        ],
      }).compile();
      const localService = moduleRef.get(TokenService);
      const t = await localService.issueAgentToken(card);
      // verify 通过（未被吊销）
      const verified = await localService.verify(t.token);
      expect(verified.jti).toBe(t.jti);
      // 吊销后 verify 应失败
      await localService.revokeAgentToken(t.jti);
      await expect(localService.verify(t.token)).rejects.toMatchObject({
        reason: 'REVOKED',
      });
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试工具
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function decodeJwtPayload(token: string): {
  iss: string;
  sub: string;
  jti: string;
  capabilities: string[];
} {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('not a JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

function signJwt(payload: unknown, secret: string): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', secret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function createInMemoryRegistry(): AgentTokenRegistry {
  const entries = new Map<
    string,
    { agentId: string; revoked: boolean; expiresAt: string }
  >();
  const registry: AgentTokenRegistry = {
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
  // 暴露内部 entries 供测试断言
  Object.defineProperty(registry, '__entries', {
    value: entries,
    enumerable: false,
  });
  return registry;
}
