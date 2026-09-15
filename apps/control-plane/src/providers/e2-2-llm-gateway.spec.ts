/**
 * E2-2: LLMGatewayService 单元测试
 *
 * 覆盖：
 * - 多供应商解析
 * - Token 预算追踪（继承 StubModelGateway）
 * - 熔断器：closed → open → half-open → closed
 * - CircuitOpenError 抛出
 * - healthy() 状态汇总
 */
import { Test } from '@nestjs/testing';
import {
  LLMGatewayService,
  CircuitOpenError,
  LLMProviderError,
} from './llm-gateway.service';
import type { ModelInferenceRequest } from '@aegisci/core/spi/models';
import { BudgetExhaustedError } from './stub-model-gateway';

describe('E2-2 LLMGatewayService', () => {
  let service: LLMGatewayService;

  const makeReq = (overrides: Partial<ModelInferenceRequest> = {}): ModelInferenceRequest => ({
    agentId: 'agent-1',
    runId: 'run-1',
    modelId: 'gpt-x',
    systemPrompt: 'sys',
    userPrompt: 'user',
    maxTokens: 64,
    temperature: 0.2,
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [LLMGatewayService],
    }).compile();
    service = moduleRef.get<LLMGatewayService>(LLMGatewayService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 多供应商解析
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('resolves openai-* model to openai provider', async () => {
    const result = await service.infer(makeReq({ modelId: 'openai-gpt-4' }));
    expect(result.modelId).toContain('openai');
    expect(service.getCircuitBreakerState('openai').state).toBe('closed');
  });

  it('resolves claude-* model to claude provider', async () => {
    const result = await service.infer(makeReq({ modelId: 'claude-3-opus' }));
    expect(result.modelId).toContain('claude');
    expect(service.getCircuitBreakerState('claude').state).toBe('closed');
  });

  it('resolves qwen-* model to qwen provider', async () => {
    const result = await service.infer(makeReq({ modelId: 'qwen-turbo' }));
    expect(result.modelId).toContain('qwen');
    expect(service.getCircuitBreakerState('qwen').state).toBe('closed');
  });

  it('falls back to default provider for unknown modelId', async () => {
    const result = await service.infer(makeReq({ modelId: 'unknown-model' }));
    expect(result).toBeDefined();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Token 预算追踪
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('tracks budget consumption across infer calls', async () => {
    await service.infer(makeReq());
    const budget = await service.getBudget('agent-1', 'run-1');
    expect(budget.consumed).toBeGreaterThan(0);
    expect(budget.remaining).toBeLessThan(budget.totalBudget);
  });

  it('budget is isolated per (agentId, runId)', async () => {
    await service.infer(makeReq({ agentId: 'a1', runId: 'r1' }));
    const b1 = await service.getBudget('a1', 'r1');
    const b2 = await service.getBudget('a1', 'r2');

    expect(b1.consumed).toBeGreaterThan(0);
    expect(b2.consumed).toBe(0); // 不同 runId，预算独立
  });

  it('BudgetExhaustedError is thrown when budget exhausted', async () => {
    // 手动设置预算耗尽
    await (service as any).budgetTracker.setBudget('agent-1', 'run-1', 100, 100);
    await expect(service.infer(makeReq({ agentId: 'agent-1', runId: 'run-1' }))).rejects.toThrow(BudgetExhaustedError);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 熔断器
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('circuit breaker opens after consecutive failures', async () => {
    const provider = 'openai';
    // 模拟连续失败
    for (let i = 0; i < 5; i++) {
      service.openCircuit(provider, i + 1);
    }

    const state = service.getCircuitBreakerState(provider);
    expect(state.state).toBe('open');
    expect(state.failureCount).toBe(5);
  });

  it('infer throws CircuitOpenError when circuit is open', async () => {
    service.openCircuit('stub', 5);

    await expect(service.infer(makeReq())).rejects.toThrow(CircuitOpenError);
  });

  it('circuit breaker recovers to half-open after timeout', async () => {
    service.openCircuit('stub', 5);

    // 手动设置 openedAt 为 60s 前（超过 30s 恢复时间）
    const breaker = service.getCircuitBreakerState('stub');
    // 通过注入方式修改 openedAt
    (service as any).circuitBreakers.get('stub').openedAt = new Date(Date.now() - 60000).toISOString();

    // 下次调用应进入 half-open 并成功
    const result = await service.infer(makeReq());
    expect(result).toBeDefined();
    expect(service.getCircuitBreakerState('stub').state).toBe('closed');
  });

  it('successful call resets failure count', async () => {
    service.openCircuit('stub', 5);
    // 先恢复到 half-open
    (service as any).circuitBreakers.get('stub').openedAt = new Date(Date.now() - 60000).toISOString();

    await service.infer(makeReq());

    expect(service.getCircuitBreakerState('stub').state).toBe('closed');
    expect(service.getCircuitBreakerState('stub').failureCount).toBe(0);
  });

  it('resetCircuit clears breaker state', async () => {
    service.openCircuit('stub', 5);
    service.resetCircuit('stub');

    const state = service.getCircuitBreakerState('stub');
    expect(state.state).toBe('closed');
    expect(state.failureCount).toBe(0);
  });

  it('resetAllCircuits clears all providers', async () => {
    service.openCircuit('openai', 5);
    service.openCircuit('claude', 5);
    service.resetAllCircuits();

    expect(service.getCircuitBreakerState('openai').state).toBe('closed');
    expect(service.getCircuitBreakerState('claude').state).toBe('closed');
    expect(service.getCircuitBreakerState('qwen').state).toBe('closed');
    expect(service.getCircuitBreakerState('stub').state).toBe('closed');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // healthy()
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('returns true when at least one provider is healthy', async () => {
    expect(await service.healthy()).toBe(true);
  });

  it('returns false when all providers are open', async () => {
    for (const provider of ['openai', 'claude', 'qwen', 'stub'] as const) {
      service.openCircuit(provider, 5);
    }
    expect(await service.healthy()).toBe(false);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 错误处理
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('LLMProviderError contains provider, modelId and cause', async () => {
    // 手动触发 provider error（通过注入）
    const error = new LLMProviderError('stub', 'gpt-x', 'connection refused');
    expect(error.provider).toBe('stub');
    expect(error.modelId).toBe('gpt-x');
    expect(error.cause).toBe('connection refused');
  });
});
