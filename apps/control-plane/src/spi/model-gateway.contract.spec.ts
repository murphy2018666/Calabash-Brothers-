import { Test } from '@nestjs/testing';
import type { ModelInferenceRequest } from '@aegisci/core/spi/models';
import {
  StubModelGateway,
  BudgetExhaustedError,
} from '../providers/stub-model-gateway';

/**
 * SPI 契约测试 —— StubModelGateway 实现 ModelGateway 接口正确性
 * （DES-13.9：双闸门不变 + Token 预算管控内置；DES-8 三级降级策略）。
 */
describe('StubModelGateway (ModelGateway SPI contract)', () => {
  let gateway: StubModelGateway;

  const req = (overrides: Partial<ModelInferenceRequest> = {}): ModelInferenceRequest => ({
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
      providers: [StubModelGateway],
    }).compile();
    gateway = moduleRef.get(StubModelGateway);
  });

  it('infer() returns a degraded stub result with token accounting', async () => {
    const result = await gateway.infer(req());
    expect(result.degraded).toBe(true);
    expect(result.cached).toBeUndefined();
    expect(result.modelId).toBe('gpt-x');
    expect(result.inputTokens).toBeGreaterThan(0);
    expect(result.outputTokens).toBeGreaterThan(0);
    expect(result.traceSpanId).toContain('run-1');
  });

  it('getBudget() initializes with default budget and tracks consumption', async () => {
    await gateway.infer(req());
    const budget = await gateway.getBudget('agent-1', 'run-1');
    expect(budget.totalBudget).toBe(8000);
    expect(budget.consumed).toBeGreaterThan(0);
    expect(budget.remaining).toBeLessThan(8000);
  });

  it('healthy() returns true', async () => {
    expect(await gateway.healthy()).toBe(true);
  });

  // ── L2-5 三级降级（DES-8）────────────────────────────────

  it('Tier 1: remaining < 50% switches to lightweight model (degraded, -lite suffix)', async () => {
    // 消耗到 <50%：totalBudget=100，消耗 60 → remaining 40 < 50
    await gateway.setBudget('agent-1', 'run-1', 100, 60);
    const result = await gateway.infer(req({ maxTokens: 16 }));
    expect(result.degraded).toBe(true);
    expect(result.modelId).toBe('gpt-x-lite');
  });

  it('Tier 2: remaining < 20% returns cached response without consuming tokens', async () => {
    // remaining 15 < 20% of 100
    await gateway.setBudget('agent-1', 'run-1', 100, 85);
    const before = (await gateway.getBudget('agent-1', 'run-1')).consumed;
    const result = await gateway.infer(req({ maxTokens: 16 }));
    expect(result.cached).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.inputTokens).toBe(0);
    expect(result.outputTokens).toBe(0);
    const after = (await gateway.getBudget('agent-1', 'run-1')).consumed;
    expect(after).toBe(before); // 缓存响应不消耗预算
  });

  it('Tier 3: remaining = 0 rejects inference with BudgetExhaustedError', async () => {
    await gateway.setBudget('agent-1', 'run-1', 100, 100);
    await expect(gateway.infer(req({ maxTokens: 16 }))).rejects.toThrow(
      BudgetExhaustedError,
    );
  });

  it('resetBudget() clears state; next infer re-initializes default budget', async () => {
    await gateway.setBudget('agent-1', 'run-1', 100, 100);
    await gateway.resetBudget('agent-1', 'run-1');
    const budget = await gateway.getBudget('agent-1', 'run-1');
    expect(budget.totalBudget).toBe(8000);
    expect(budget.consumed).toBe(0);
    await expect(gateway.infer(req({ maxTokens: 16 }))).resolves.toBeDefined();
  });

  it('budgets are isolated per (agentId, runId)', async () => {
    await gateway.setBudget('agent-1', 'run-1', 100, 100);
    // 其他 (agent, run) 不受影响
    const other = await gateway.getBudget('agent-1', 'run-2');
    expect(other.remaining).toBe(8000);
    await expect(gateway.infer(req({ runId: 'run-2', maxTokens: 16 }))).resolves.toBeDefined();
  });
});
