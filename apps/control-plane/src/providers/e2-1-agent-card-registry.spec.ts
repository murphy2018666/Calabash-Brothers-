/**
 * E2-1: AgentCardRegistryService 单元测试
 *
 * 覆盖：
 * - discoverByRole：按角色发现 + 健康检查过滤
 * - listAll：全量盘点
 * - deregister：注销 + 缓存清除
 * - refreshCache：缓存刷新
 * - healthCheck：健康检查汇总
 */
import { Test } from '@nestjs/testing';
import { AgentCardRegistryService } from './agent-card-registry.service';
import { InMemoryAgentProvider } from './in-memory-agent-provider';
import type { AgentCard, AgentRole } from '@aegisci/shared/types';
import { SPI_TOKENS } from '@aegisci/core/spi';

describe('E2-1 AgentCardRegistryService', () => {
  let service: AgentCardRegistryService;
  let provider: InMemoryAgentProvider;

  const makeCard = (overrides: Partial<AgentCard> = {}): AgentCard => ({
    agentId: 'agent-1',
    role: 'reviewer' as AgentRole,
    displayName: 'Reviewer Agent',
    modelId: 'gpt-x',
    capabilities: ['git.diff', 'policy.read'],
    riskTier: 'G2',
    tenantId: 'tenant-1',
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentCardRegistryService,
        InMemoryAgentProvider,
        { provide: SPI_TOKENS.AGENT_PROVIDER, useExisting: InMemoryAgentProvider },
      ],
      imports: [],
    }).compile();

    provider = moduleRef.get<InMemoryAgentProvider>(InMemoryAgentProvider);
    service = moduleRef.get<AgentCardRegistryService>(AgentCardRegistryService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // discoverByRole
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('discovers agent by role with token budget', async () => {
    await provider.register(makeCard());

    const agents = await service.discoverByRole('reviewer', 'tenant-1');

    expect(agents).toHaveLength(1);
    expect(agents[0].agentId).toBe('agent-1');
    expect(agents[0].role).toBe('reviewer');
    expect(agents[0].tokenBudget).toBe(8000); // 默认预算
  });

  it('filters by tenant', async () => {
    await provider.register(makeCard({ agentId: 'a1', tenantId: 'tenant-1' }));
    await provider.register(makeCard({ agentId: 'a2', tenantId: 'tenant-2', role: 'reviewer' }));

    const t1 = await service.discoverByRole('reviewer', 'tenant-1');
    const t2 = await service.discoverByRole('reviewer', 'tenant-2');

    expect(t1.map((a) => a.agentId)).toEqual(['a1']);
    expect(t2.map((a) => a.agentId)).toEqual(['a2']);
  });

  it('returns empty array when no agents match', async () => {
    const agents = await service.discoverByRole('ops', 'tenant-1');
    expect(agents).toEqual([]);
  });

  it('caches result for same role', async () => {
    await provider.register(makeCard());
    const first = await service.discoverByRole('reviewer', 'tenant-1');
    const second = await service.discoverByRole('reviewer', 'tenant-1');

    // 第二次应返回缓存结果（同一引用）
    expect(first).toBe(second);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // listAll
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('lists all registered agents across roles', async () => {
    await provider.register(makeCard({ role: 'reviewer', agentId: 'r1' }));
    await provider.register(makeCard({ role: 'tester', agentId: 't1' }));
    await provider.register(makeCard({ role: 'security', agentId: 's1' }));

    const result = await service.listAll('tenant-1');

    expect(result.totalRegistered).toBe(3);
    expect(result.healthyCount).toBe(3);
    expect(result.agents.map((a) => a.agentId).sort()).toEqual(['r1', 's1', 't1']);
  });

  it('returns zero agents when none registered', async () => {
    const result = await service.listAll('tenant-1');
    expect(result.totalRegistered).toBe(0);
    expect(result.healthyCount).toBe(0);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // deregister
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('deregisters agent and clears cache', async () => {
    await provider.register(makeCard({ role: 'reviewer', agentId: 'r1' }));
    await service.discoverByRole('reviewer', 'tenant-1'); // 填充缓存

    await service.deregister('r1');

    const agents = await service.discoverByRole('reviewer', 'tenant-1');
    expect(agents).toEqual([]);
  });

  it('deregister non-existent agent is no-op', async () => {
    await expect(service.deregister('ghost')).resolves.toBeUndefined();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // refreshCache
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('refreshCache invalidates all role caches', async () => {
    await provider.register(makeCard({ role: 'reviewer', agentId: 'r1' }));
    await service.discoverByRole('reviewer', 'tenant-1');

    await service.refreshCache();

    // 缓存已清除，需要重新 discovery
    await provider.register(makeCard({ role: 'reviewer', agentId: 'r2' }));
    const agents = await service.discoverByRole('reviewer', 'tenant-1');
    expect(agents.map((a) => a.agentId)).toContain('r2');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // healthCheck
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('returns healthy when agents registered', async () => {
    await provider.register(makeCard());
    const health = await service.healthCheck();
    expect(health.healthy).toBe(true);
    expect(health.agentCount).toBeGreaterThan(0);
  });

  it('returns unhealthy when no agents', async () => {
    const health = await service.healthCheck();
    expect(health.healthy).toBe(false);
    expect(health.agentCount).toBe(0);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Token 预算
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('uses default budget when model.budget not specified', async () => {
    await provider.register(makeCard());
    const agents = await service.discoverByRole('reviewer', 'tenant-1');
    expect(agents[0].tokenBudget).toBe(8000);
  });

  it('reads custom budget from model.budget', async () => {
    const card = makeCard({
      agentId: 'custom-budget-agent',
      model: { budget: 16000 },
    } as unknown as AgentCard);
    await provider.register(card);

    const agents = await service.discoverByRole('reviewer', 'tenant-1');
    expect(agents[0].tokenBudget).toBe(16000);
  });
});
