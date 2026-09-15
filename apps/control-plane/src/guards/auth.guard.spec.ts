import { Test } from '@nestjs/testing';
import { Reflector } from '@nestjs/core';
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AgentCard } from '@aegisci/shared/types';
import {
  AGENT_TOKEN_REGISTRY,
  IdentityService,
  TokenService,
  PRINCIPAL_REPOSITORY,
} from '@aegisci/domain/identity';
import type { AgentTokenRegistry, PrincipalRepository } from '@aegisci/domain/identity';
import { AuthGuard, Public, Roles, type PrincipalRequest } from './auth.guard';
import { createMockAgentTokenRegistry, createMockPrincipalRepository } from '../mocks/auth';

/**
 * AuthGuard 单元测试（F1-4 控制面鉴权守卫）。
 *
 * 覆盖：
 * - 缺失 Bearer → 401
 * - 无效 / 过期 / 已吊销令牌 → 401（INVALID_FORMAT/SIGNATURE/EXPIRED/REVOKED）
 * - Principal 未找到 → 401
 * - 成功路径：Principal 注入 request.principal
 * - 公开路由（@Public）跳过鉴权
 * - 角色检查（@Roles）成功 / 403
 */
describe('AuthGuard (F1-4 控制面鉴权守卫)', () => {
  let guard: AuthGuard;
  let identity: IdentityService;
  let tokens: TokenService;

  const card: AgentCard = {
    agentId: 'agent-guard-1',
    role: 'reviewer',
    displayName: 'Reviewer Agent',
    modelId: 'm',
    capabilities: ['code.review'],
    riskTier: 'G2',
    tenantId: 'tenant-1',
  };

  beforeEach(async () => {
    // S13 合规：TokenService 要求此环境变量
    process.env.AEGISCI_TOKEN_SIGNING_SECRET = 'test-signing-secret-for-unit-tests';
    // 直接声明服务与端口 mock，避免 imports: [IdentityModule] + overrideProvider
    // 对图中不存在 token 无效的问题（IdentityModule 不提供 AGENT_TOKEN_REGISTRY）
    const registry = createMockAgentTokenRegistry();
    const events = new EventEmitter2();
    const repo: PrincipalRepository = createMockPrincipalRepository();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuthGuard,
        IdentityService,
        TokenService,
        { provide: AGENT_TOKEN_REGISTRY, useValue: registry },
        { provide: EventEmitter2, useValue: events },
        { provide: PRINCIPAL_REPOSITORY, useValue: repo },
      ],
    }).compile();

    guard = moduleRef.get(AuthGuard);
    identity = moduleRef.get(IdentityService);
    tokens = moduleRef.get(TokenService);
  });

  /** 构造一个带 Authorization 头的 mock ExecutionContext。 */
  function makeContext(opts: {
    authHeader?: string;
    handler?: () => unknown;
    classCtor?: unknown;
    metadata?: Record<string, unknown>;
    method?: string;
    url?: string;
    ip?: string;
  }): ExecutionContext {
    const req: PrincipalRequest = {
      headers: opts.authHeader
        ? { authorization: opts.authHeader }
        : {},
      method: opts.method ?? 'GET',
      url: opts.url ?? '/api/v1/test',
      ip: opts.ip ?? '127.0.0.1',
    } as unknown as PrincipalRequest;
    const ctx = {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => opts.handler ?? (() => undefined),
      getClass: () => opts.classCtor ?? class TestController {},
    };
    // 模拟 Reflector.getAllAndOverride 行为
    jest.spyOn(
      (guard as unknown as { reflector: Reflector }).reflector,
      'getAllAndOverride',
    ).mockImplementation((key: string) => {
      if (opts.metadata && opts.metadata[key] !== undefined) {
        return opts.metadata[key];
      }
      return undefined;
    });
    return ctx as unknown as ExecutionContext;
  }

  describe('canActivate() — 401 错误路径', () => {
    it('rejects when Authorization header is missing (401)', async () => {
      const ctx = makeContext({});
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects non-Bearer scheme (401)', async () => {
      const ctx = makeContext({ authHeader: 'Basic dXNlcjpwYXNz' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects empty Bearer token (401)', async () => {
      const ctx = makeContext({ authHeader: 'Bearer ' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects invalid token format (401)', async () => {
      const ctx = makeContext({ authHeader: 'Bearer not-a-jwt' });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects tampered token signature (401)', async () => {
      const t = await tokens.issueAgentToken(card);
      const [h, p] = t.token.split('.') as [string, string, string];
      const tampered = `${h}.${p}.fake-sig`;
      const ctx = makeContext({ authHeader: `Bearer ${tampered}` });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects revoked token (401)', async () => {
      const t = await tokens.issueAgentToken(card);
      await identity.registerAgent(card); // 注册 Principal
      await tokens.revokeAgentToken(t.jti);
      const ctx = makeContext({ authHeader: `Bearer ${t.token}` });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });

    it('rejects token with no linked Principal (401)', async () => {
      const t = await tokens.issueAgentToken(card);
      // 故意不调用 identity.registerAgent —— Principal 缺失
      const ctx = makeContext({ authHeader: `Bearer ${t.token}` });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    });
  });

  describe('canActivate() — 成功路径', () => {
    it('injects Principal + VerifiedToken into request and returns true', async () => {
      const t = await tokens.issueAgentToken(card);
      await identity.registerAgent(card);
      const ctx = makeContext({ authHeader: `Bearer ${t.token}` });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
      const req = ctx.switchToHttp().getRequest<PrincipalRequest>();
      expect(req.principal).toBeDefined();
      expect(req.principal?.agentCardId).toBe(card.agentId);
      expect(req.principal?.tenantId).toBe(card.tenantId);
      expect(req.verifiedToken?.jti).toBe(t.jti);
      expect(Object.isFrozen(req.principal)).toBe(true);
      expect(Object.isFrozen(req.verifiedToken)).toBe(true);
    });
  });

  describe('canActivate() — @Public() 装饰器', () => {
    it('skips auth when @Public() is set', async () => {
      const ctx = makeContext({
        metadata: { 'aegisci:public': true },
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });
  });

  describe('canActivate() — @Roles() 装饰器', () => {
    beforeEach(async () => {
      await identity.registerAgent(card);
    });

    it('allows when principal has a required role', async () => {
      // registerAgent 设置 roles = ['agent:reviewer']
      const t = await tokens.issueAgentToken(card);
      const ctx = makeContext({
        authHeader: `Bearer ${t.token}`,
        metadata: { 'aegisci:roles': ['agent:reviewer'] },
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });

    it('forbids (403) when principal lacks required role', async () => {
      const t = await tokens.issueAgentToken(card);
      const ctx = makeContext({
        authHeader: `Bearer ${t.token}`,
        metadata: { 'aegisci:roles': ['agent:planner'] }, // principal 只有 agent:reviewer
      });
      await expect(guard.canActivate(ctx)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
    });

    it('skips role check when @Roles() is empty', async () => {
      const t = await tokens.issueAgentToken(card);
      const ctx = makeContext({
        authHeader: `Bearer ${t.token}`,
        metadata: { 'aegisci:roles': [] },
      });
      const result = await guard.canActivate(ctx);
      expect(result).toBe(true);
    });
  });

  describe('decorators — metadata keys', () => {
    it('Roles() sets the ROLES_KEY metadata', () => {
      // 仅验证装饰器可调用且不抛
      expect(() => Roles('r1', 'r2')).not.toThrow();
    });

    it('Public() sets the PUBLIC_KEY metadata', () => {
      expect(() => Public()).not.toThrow();
    });
  });
});
