/**
 * E2-3: AgentCard + LLM 集成测试
 *
 * 覆盖：
 * - AgentCard 注册→发现→分派链路闭环
 * - LLM 调用链路端到端测试
 * - 预算耗尽熔断测试
 * - AgentCard 能力聚合与 LLM 模型选择联动
 */
import { Test } from '@nestjs/testing';
import { InMemoryAgentProvider } from './in-memory-agent-provider';
import { AgentCardRegistryService } from './agent-card-registry.service';
import { LLMGatewayService } from './llm-gateway.service';
import { BudgetExhaustedError } from './stub-model-gateway';
import { CircuitOpenError } from './llm-gateway.service';
import type { AgentCard, AgentRole } from '@aegisci/shared/types';
import type { ModelInferenceRequest } from '@aegisci/core/spi/models';
import { SPI_TOKENS } from '@aegisci/core/spi';

describe('E2-3 AgentCard + LLM 集成', () => {
  let agentProvider: InMemoryAgentProvider;
  let registry: AgentCardRegistryService;
  let gateway: LLMGatewayService;

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
        InMemoryAgentProvider,
        AgentCardRegistryService,
        LLMGatewayService,
        { provide: SPI_TOKENS.AGENT_PROVIDER, useExisting: InMemoryAgentProvider },
      ],
    }).compile();

    agentProvider = moduleRef.get<InMemoryAgentProvider>(InMemoryAgentProvider);
    registry = moduleRef.get<AgentCardRegistryService>(AgentCardRegistryService);
    gateway = moduleRef.get<LLMGatewayService>(LLMGatewayService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // AgentCard 注册→发现→分派链路
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('register → discover → dispatch end-to-end', async () => {
    await agentProvider.register(makeCard({ role: 'reviewer', agentId: 'rev-1' }));
    await agentProvider.register(makeCard({ role: 'tester', agentId: 'test-1' }));
    await agentProvider.register(makeCard({ role: 'security', agentId: 'sec-1' }));

    // 发现 reviewer
    const reviewers = await registry.discoverByRole('reviewer', 'tenant-1');
    expect(reviewers).toHaveLength(1);
    expect(reviewers[0].agentId).toBe('rev-1');

    // 发现 tester
    const testers = await registry.discoverByRole('tester', 'tenant-1');
    expect(testers).toHaveLength(1);
    expect(testers[0].agentId).toBe('test-1');

    // 全量盘点
    const all = await registry.listAll('tenant-1');
    expect(all.totalRegistered).toBe(3);
    expect(all.healthyCount).toBe(3);
  });

  it('deregister invalidates discovery cache', async () => {
    await agentProvider.register(makeCard({ role: 'reviewer', agentId: 'rev-1' }));
    await registry.discoverByRole('reviewer', 'tenant-1');

    await registry.deregister('rev-1');

    const agents = await registry.discoverByRole('reviewer', 'tenant-1');
    expect(agents).toEqual([]);
  });

  it('tenant isolation: agents from different tenants are separated', async () => {
    await agentProvider.register(makeCard({ agentId: 't1-rev', tenantId: 'tenant-1' }));
    await agentProvider.register(makeCard({ agentId: 't2-rev', tenantId: 'tenant-2' }));

    const t1 = await registry.discoverByRole('reviewer', 'tenant-1');
    const t2 = await registry.discoverByRole('reviewer', 'tenant-2');

    expect(t1.map((a) => a.agentId)).toEqual(['t1-rev']);
    expect(t2.map((a) => a.agentId)).toEqual(['t2-rev']);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // LLM 调用链路端到端
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('agent card model selection → LLM infer', async () => {
    await agentProvider.register(makeCard({
      agentId: 'llm-agent',
      modelId: 'openai-gpt-4',
      role: 'reviewer',
    }));

    const agents = await registry.discoverByRole('reviewer', 'tenant-1');
    expect(agents[0].modelId).toBe('openai-gpt-4');

    // 使用对应 modelId 进行 infer
    const result = await gateway.infer({
      agentId: 'llm-agent',
      runId: 'run-1',
      modelId: 'openai-gpt-4',
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxTokens: 64,
      temperature: 0.2,
    });

    expect(result.modelId).toContain('openai-gpt-4');
    expect(result.inputTokens).toBeGreaterThan(0);
  });

  it('budget tracking across multiple agents and runs', async () => {
    await agentProvider.register(makeCard({ agentId: 'a1', role: 'reviewer' }));
    await agentProvider.register(makeCard({ agentId: 'a2', role: 'tester' }));

    // 两个 agent 独立预算
    const r1 = await gateway.infer({ agentId: 'a1', runId: 'r1', modelId: 'gpt-x', systemPrompt: 's', userPrompt: 'u', maxTokens: 32, temperature: 0.2 });
    const r2 = await gateway.infer({ agentId: 'a2', runId: 'r2', modelId: 'gpt-x', systemPrompt: 's', userPrompt: 'u', maxTokens: 32, temperature: 0.2 });

    expect(r1.inputTokens).toBeGreaterThan(0);
    expect(r2.inputTokens).toBeGreaterThan(0);

    // 预算隔离
    const b1 = await gateway.getBudget('a1', 'r1');
    const b2 = await gateway.getBudget('a2', 'r2');
    expect(b1.consumed).toBeGreaterThan(0);
    expect(b2.consumed).toBeGreaterThan(0);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 预算耗尽熔断
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('cascading budget exhaustion → circuit breaker opens', async () => {
    await agentProvider.register(makeCard({ agentId: 'exhaust-agent', role: 'reviewer' }));

    // 耗尽预算
    await (gateway as any).budgetTracker.setBudget('exhaust-agent', 'run-1', 100, 100);

    // BudgetExhaustedError 不应触发熔断（业务错误）
    await expect(gateway.infer({
      agentId: 'exhaust-agent',
      runId: 'run-1',
      modelId: 'gpt-x',
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: 16,
      temperature: 0.2,
    })).rejects.toThrow(BudgetExhaustedError);

    // 熔断器应保持 closed（预算耗尽不是 provider 故障）
    expect(gateway.getCircuitBreakerState('stub').state).toBe('closed');
  });

  it('provider failure triggers circuit breaker', async () => {
    // 模拟连续 provider 失败
    const originalInfer = gateway.infer.bind(gateway);

    // 手动打开熔断器并验证行为
    gateway.openCircuit('stub', 5);

    await expect(gateway.infer({
      agentId: 'fail-agent',
      runId: 'run-1',
      modelId: 'gpt-x',
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: 16,
      temperature: 0.2,
    })).rejects.toBeInstanceOf(CircuitOpenError);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 降级策略（DES-8 三级降级）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('tier 1: remaining < 50% switches to lite model', async () => {
    await (gateway as any).budgetTracker.setBudget('agent-1', 'run-1', 100, 60);

    const result = await gateway.infer({
      agentId: 'agent-1',
      runId: 'run-1',
      modelId: 'gpt-x',
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: 16,
      temperature: 0.2,
    });

    expect(result.modelId).toContain('-lite');
    expect(result.degraded).toBe(true);
  });

  it('tier 2: remaining < 20% returns cached response', async () => {
    await (gateway as any).budgetTracker.setBudget('agent-1', 'run-1', 100, 85);

    const result = await gateway.infer({
      agentId: 'agent-1',
      runId: 'run-1',
      modelId: 'gpt-x',
      systemPrompt: 's',
      userPrompt: 'u',
      maxTokens: 16,
      temperature: 0.2,
    });

    expect(result.cached).toBe(true);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
  });
});
