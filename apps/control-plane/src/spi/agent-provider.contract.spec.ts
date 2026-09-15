import { Test } from '@nestjs/testing';
import type { AgentCard } from '@aegisci/shared/types';
import { InMemoryAgentProvider } from '../providers/in-memory-agent-provider';

/**
 * SPI 契约测试 —— InMemoryAgentProvider 实现 AgentProvider 接口正确性
 * （DES-13.9：AgentCard 声明式注册不可扩权；内置与第三方同生命周期 FR-M7-07）。
 */
describe('InMemoryAgentProvider (AgentProvider SPI contract)', () => {
  let provider: InMemoryAgentProvider;

  const card = (overrides: Partial<AgentCard> = {}): AgentCard => ({
    agentId: 'agent-1',
    role: 'reviewer',
    displayName: 'Reviewer Agent',
    modelId: 'gpt-x',
    capabilities: ['git.diff', 'policy.read'],
    riskTier: 'G2',
    tenantId: 'tenant-1',
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [InMemoryAgentProvider],
    }).compile();
    provider = moduleRef.get(InMemoryAgentProvider);
  });

  it('register + getCard returns the registered card (read-your-writes)', async () => {
    await provider.register(card());
    const loaded = await provider.getCard('agent-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.agentId).toBe('agent-1');
    expect(loaded?.role).toBe('reviewer');
  });

  it('getCard returns null for unknown agent', async () => {
    expect(await provider.getCard('nope')).toBeNull();
  });

  it('listByRole filters by role AND tenant', async () => {
    await provider.register(card());
    await provider.register(card({ agentId: 'agent-2', role: 'ops' }));
    await provider.register(card({ agentId: 'agent-3', tenantId: 'tenant-2' }));

    const reviewers = await provider.listByRole('reviewer', 'tenant-1');
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0].agentId).toBe('agent-1');

    const otherTenant = await provider.listByRole('reviewer', 'tenant-2');
    expect(otherTenant.map((c) => c.agentId)).toEqual(['agent-3']);
  });

  it('deregister removes the card; deregister non-existent is a no-op', async () => {
    await provider.register(card());
    await provider.deregister('agent-1');
    expect(await provider.getCard('agent-1')).toBeNull();
    await expect(provider.deregister('ghost')).resolves.toBeUndefined();
  });

  it('duplicate register overwrites (upsert semantics)', async () => {
    await provider.register(card({ displayName: 'v1' }));
    await provider.register(card({ displayName: 'v2' }));
    const loaded = await provider.getCard('agent-1');
    expect(loaded?.displayName).toBe('v2');
  });

  it('healthy() returns true', async () => {
    expect(await provider.healthy()).toBe(true);
  });

  // ── L2-4 深化 ──────────────────────────────────────────────

  it('listTools aggregates capabilities across agents with dedup', async () => {
    await provider.register(card({ capabilities: ['git.diff', 'policy.read'] }));
    await provider.register(
      card({ agentId: 'agent-2', capabilities: ['git.diff', 'shell.exec'] }),
    );
    const tools = await provider.listTools();
    expect(tools.sort()).toEqual(['git.diff', 'policy.read', 'shell.exec']);
  });

  it('listTools returns empty array when no agents registered', async () => {
    expect(await provider.listTools()).toEqual([]);
  });

  it('healthCheck returns registeredCount detail', async () => {
    expect(await provider.healthCheck()).toEqual({ healthy: true, registeredCount: 0 });
    await provider.register(card());
    expect(await provider.healthCheck()).toEqual({ healthy: true, registeredCount: 1 });
  });
});
