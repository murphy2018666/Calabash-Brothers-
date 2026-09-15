import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import type { CredentialJtiRegistry } from '@aegisci/domain/policy/credential';
import type { IssuedCredential } from '@aegisci/core/spi/secrets';
import { FuseService } from './fuse-service';
import { InMemoryFuseCircuit, FUSE_CIRCUIT } from './in-memory-fuse-circuit';

/**
 * F3 FuseService 单元测试（Token 生命周期与熔断）。
 *
 * 覆盖：
 * - issue() 签发凭证（JWT 形状、JTI 注册）
 * - emergencyFreeze() 熔断广播（≤10s 全节点吊销）
 * - revoke() 单凭证吊销（不触发广播）
 * - 健康检查
 * - 无活跃 token 时紧急冻结
 * - 熔断通道故障时拒绝广播
 */
describe('FuseService (F3 Token 熔断广播)', () => {
  let fuseService: FuseService;
  let registry: {
    __entries: Map<string, { principal: string; revoked: boolean }>;
    register: jest.Mock;
    revoke: jest.Mock;
    listByPrincipal: jest.Mock;
    listByPrincipal: jest.Mock;
    isRevoked: jest.Mock;
    listAll: jest.Mock;
  };
  let fuse: InMemoryFuseCircuit;
  let emitter: EventEmitter2;

  beforeEach(() => {
    emitter = new EventEmitter2();
    registry = {
      __entries: new Map(),
      register: jest.fn().mockImplementation(
        async (jti: string, entry: { principal: string }, _ttl: number) => {
          registry.__entries.set(jti, { ...entry, revoked: false });
        },
      ),
      revoke: jest.fn().mockImplementation(async (jti: string) => {
        const e = registry.__entries.get(jti);
        if (e) registry.__entries.set(jti, { ...e, revoked: true });
      }),
      listByPrincipal: jest.fn().mockImplementation(async (principal: string) =>
        Array.from(registry.__entries.entries())
          .filter(([, e]) => e.principal === principal && !e.revoked)
          .map(([jti]) => jti),
      ),
      isRevoked: jest.fn().mockImplementation(async (jti: string) =>
        registry.__entries.get(jti)?.revoked ?? false,
      ),
      listAll: jest.fn().mockImplementation(async () =>
        Array.from(registry.__entries.entries())
          .filter(([, e]) => !e.revoked)
          .map(([jti, e]) => ({ jti, ...e })),
      ),
    } as unknown as CredentialJtiRegistry;

    fuse = new InMemoryFuseCircuit(emitter);
    fuseService = new FuseService(registry, fuse, emitter);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // issue()
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('F3-1-1: issue() returns JWT-like token with JTI', async () => {
    const cred = await fuseService.issue('ev-1', {
      actions: ['deploy'],
      resources: ['staging/*'],
      environment: 'staging',
      ttl: 600,
    }, 'agent-scorer');

    expect(cred.jti).toMatch(/^[0-9a-f-]{36}$/);
    expect(cred.token).toMatch(/\.[\w-]+\.[\w-]+$/);
    expect(cred.expiresAt).toBeDefined();
    expect(cred.scope.actions).toEqual(['deploy']);
    // TTL capped at 30min
    const ttlActual = (new Date(cred.expiresAt).getTime() - Date.now()) / 1000;
    expect(ttlActual).toBeLessThanOrEqual(600);
  });

  it('F3-1-2: TTL capped at 30min (MAX_TTL_SECONDS)', async () => {
    const cred = await fuseService.issue('ev-1', {
      actions: ['deploy'],
      resources: ['*'],
      environment: 'prod',
      ttl: 999_999,
    }, 'agent-scorer');
    const ttlActual = (new Date(cred.expiresAt).getTime() - Date.now()) / 1000;
    expect(ttlActual).toBeLessThanOrEqual(30 * 60);
  });

  it('F3-1-3: revoke() revokes single JTI without triggering broadcast', async () => {
    const cred = await fuseService.issue('ev-1', {
      actions: ['deploy'],
      resources: ['staging/*'],
      environment: 'staging',
      ttl: 600,
    }, 'agent-scorer');

    await fuseService.revoke(cred.jti);

    // registry 已吊销
    expect(registry.__entries.get(cred.jti)?.revoked).toBe(true);
    // 无广播
    expect(fuse.getHistory()).toHaveLength(0);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // emergencyFreeze()
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('F3-2-1: emergencyFreeze() revokes all tokens and broadcasts', async () => {
    const c1 = await fuseService.issue('ev-1', {
      actions: ['deploy'], resources: ['s/*'], environment: 'staging', ttl: 600,
    }, 'agent-scorer');
    const c2 = await fuseService.issue('ev-2', {
      actions: ['read'], resources: ['s/*'], environment: 'staging', ttl: 600,
    }, 'agent-scorer');
    // 另一 principal 不应被影响
    const c3 = await fuseService.issue('ev-3', {
      actions: ['deploy'], resources: ['p/*'], environment: 'prod', ttl: 600,
    }, 'agent-deployer');

    const broadcast = await fuseService.emergencyFreeze('agent-scorer');

    // agent-scorer 两个 token 都被吊销
    expect(registry.__entries.get(c1.jti)?.revoked).toBe(true);
    expect(registry.__entries.get(c2.jti)?.revoked).toBe(true);
    // agent-deployer 不受影响（principal 不同，不应出现在 agent-scorer 的吊销列表）
    const allTokens = await registry.listAll();
    const deployerTokens = allTokens.filter((t) => t.principal === 'agent-deployer');
    expect(deployerTokens.length).toBe(1);
    expect(deployerTokens[0].jti).toBe(c3.jti);
    // 广播历史存在
    expect(broadcast.principal).toBe('agent-scorer');
    expect(broadcast.jtis).toHaveLength(2);
    expect(broadcast.broadcastAt).toBeDefined();
  });

  it('F3-2-2: emergencyFreeze() with no active tokens returns empty broadcast', async () => {
    const broadcast = await fuseService.emergencyFreeze('nonexistent-agent');
    expect(broadcast.jtis).toHaveLength(0);
    // 无 token 时不调用 broadcast，history 为空
    expect(fuse.getHistory()).toHaveLength(0);
  });

  it('F3-2-3: EmergencyFrozen event emitted on broadcast', async () => {
    await fuseService.issue('ev-1', {
      actions: ['deploy'], resources: ['s/*'], environment: 'staging', ttl: 600,
    }, 'agent-scorer');

    const spy = jest.fn();
    emitter.on('EmergencyFrozen', spy);
    await fuseService.emergencyFreeze('agent-scorer');

    expect(spy).toHaveBeenCalled();
    const eventArg = spy.mock.calls[0][0] as { principal: string; jtis: string[] };
    expect(eventArg.principal).toBe('agent-scorer');
    expect(eventArg.jtis.length).toBeGreaterThanOrEqual(1);
  });

  it('F3-2-4: TokenRevoked event emitted after broadcast', async () => {
    await fuseService.issue('ev-1', {
      actions: ['deploy'], resources: ['s/*'], environment: 'staging', ttl: 600,
    }, 'agent-scorer');

    const spy = jest.fn();
    emitter.on('TokenRevoked', spy);
    await fuseService.emergencyFreeze('agent-scorer');

    expect(spy).toHaveBeenCalled();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 健康检查 & 降级
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('F3-3-1: health() returns healthy by default', async () => {
    const h = await fuseService.health();
    expect(h.healthy).toBe(true);
    expect(h.broadcastHealthy).toBe(true);
  });

  it('F3-3-2: healthy=false blocks broadcast', async () => {
    fuse.setHealthy(false);
    await fuseService.issue('ev-1', {
      actions: ['deploy'], resources: ['s/*'], environment: 'staging', ttl: 600,
    }, 'agent-scorer');

    await expect(fuseService.emergencyFreeze('agent-scorer')).rejects.toThrow('unhealthy');
  });

  it('F3-3-3: single revoke works even when broadcast channel is unhealthy', async () => {
    fuse.setHealthy(false);
    const cred = await fuseService.issue('ev-1', {
      actions: ['deploy'], resources: ['s/*'], environment: 'staging', ttl: 600,
    }, 'agent-scorer');

    // 单吊销不受通道健康度影响
    await expect(fuseService.revoke(cred.jti)).resolves.toBeUndefined();
    expect(registry.__entries.get(cred.jti)?.revoked).toBe(true);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 边界条件
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('F3-4-1: concurrent emergencyFreeze() on same principal is idempotent', async () => {
    await fuseService.issue('ev-1', {
      actions: ['deploy'], resources: ['s/*'], environment: 'staging', ttl: 600,
    }, 'agent-scorer');

    const [b1, b2] = await Promise.all([
      fuseService.emergencyFreeze('agent-scorer'),
      fuseService.emergencyFreeze('agent-scorer'),
    ]);

    // 两次广播都成功，但 token 只被吊销一次（幂等）
    expect(b1.jtis.length).toBe(1);
    expect(b2.jtis.length).toBe(1);
    expect(fuse.getHistory()).toHaveLength(2);
  });

  it('F3-4-2: EmergencyFrozen broadcast contains all current active jtis', async () => {
    await fuseService.issue('ev-1', {
      actions: ['deploy'], resources: ['s/*'], environment: 'staging', ttl: 600,
    }, 'agent-scorer');
    await fuseService.issue('ev-2', {
      actions: ['read'], resources: ['s/*'], environment: 'staging', ttl: 600,
    }, 'agent-scorer');
    await fuseService.issue('ev-3', {
      actions: ['deploy'], resources: ['s/*'], environment: 'staging', ttl: 600,
    }, 'agent-scorer');

    const broadcast = await fuseService.emergencyFreeze('agent-scorer');
    expect(broadcast.jtis).toHaveLength(3);
  });
});
