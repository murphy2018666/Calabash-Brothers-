/**
 * G3 成本度量服务单元测试
 *
 * 验证：
 * - G3-1 成本记录与汇总
 * - G3-2 Span → CostEntry 转换
 * - G3-3 Audit → CostEntry 转换
 * - G3-4 定价策略热更新
 */
import { CostMetricService, type CostEntry, type CostDimension, type SkillCostSummary } from './g3-cost-metric-service';
import type { TraceSpan } from '@aegisci/core/spi/trace';
import type { AuditEnvelope } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// G3-1 基本成本记录与汇总
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('G3-1 CostMetricService 基本操作', () => {
  let service: CostMetricService;

  beforeEach(() => {
    service = new CostMetricService();
    service.clear();
  });

  it('G3-1-1: record adds entry and count increases', () => {
    service.record({
      tenantId: 't1',
      dimension: 'runner',
      entityId: 'r1',
      metricName: 'cost.runner',
      value: 100,
      unit: 'ms',
      timestamp: '2026-09-09T00:00:00Z',
    });
    expect(service.getCount()).toBe(1);
  });

  it('G3-1-2: getSummary returns zero when no entries', () => {
    const summary = service.getSummary({
      tenantId: 't1',
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59Z',
    });
    expect(summary.totalUsd).toBe(0);
    expect(Object.keys(summary.byDimension).length).toBe(0);
  });

  it('G3-1-3: getSummary aggregates by dimension', () => {
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 500, unit: 'ms', timestamp: '2026-09-09T00:00:00Z' });
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r2', metricName: 'cost.runner', value: 300, unit: 'ms', timestamp: '2026-09-09T00:01:00Z' });
    service.record({ tenantId: 't1', dimension: 'agent', entityId: 'a1', metricName: 'cost.agent', value: 1000, unit: 'token', timestamp: '2026-09-09T00:02:00Z' });

    const summary = service.getSummary({
      tenantId: 't1',
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59Z',
    });

    expect(summary.byDimension['runner'].totalValue).toBe(800);
    expect(summary.byDimension['runner'].count).toBe(2);
    expect(summary.byDimension['agent'].totalValue).toBe(1000);
    expect(summary.byDimension['agent'].count).toBe(1);
  });

  it('G3-1-4: getSummary filters by time range', () => {
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 100, unit: 'ms', timestamp: '2025-01-01T00:00:00Z' });
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 200, unit: 'ms', timestamp: '2026-09-09T00:00:00Z' });

    const summary = service.getSummary({
      tenantId: 't1',
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59Z',
    });
    expect(summary.byDimension['runner'].totalValue).toBe(200);
  });

  it('G3-1-5: toUsd applies pricing rates', () => {
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 10000, unit: 'ms', timestamp: '2026-09-09T00:00:00Z' });
    const usd = service.toUsd([
      { tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 10000, unit: 'ms', timestamp: '2026-09-09T00:00:00Z' },
    ]);
    // 默认 runner 速率 0.0001 USD/ms → 10000 * 0.0001 = 1.0
    expect(usd).toBeCloseTo(1.0, 4);
  });

  it('G3-1-6: clear resets all entries', () => {
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 1, unit: 'ms', timestamp: '2026-09-09T00:00:00Z' });
    service.clear();
    expect(service.getCount()).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// G3-2 TraceSpan → CostEntry
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('G3-2 fromSpan', () => {
  it('G3-2-1: extracts runner cost from span attributes', () => {
    const span: TraceSpan = {
      spanId: 'span-1',
      traceId: 'trace-1',
      name: 'runner.step',
      startTime: Date.now(),
      attributes: {
        'cost.dimension': 'runner',
        'cost.entity': 'runner-abc',
        'cost.value': 5000,
        'tenant.id': 't1',
      },
      events: [],
      status: 'ok',
    };
    const entry = CostMetricService.fromSpan(span);
    expect(entry).not.toBeNull();
    expect(entry!.dimension).toBe('runner');
    expect(entry!.entityId).toBe('runner-abc');
    expect(entry!.value).toBe(5000);
    expect(entry!.unit).toBe('ms');
  });

  it('G3-2-2: returns null when cost.dimension missing', () => {
    const span: TraceSpan = {
      spanId: 'span-1',
      traceId: 'trace-1',
      name: 'tool.echo',
      startTime: Date.now(),
      attributes: {},
      events: [],
      status: 'ok',
    };
    expect(CostMetricService.fromSpan(span)).toBeNull();
  });

  it('G3-2-3: handles agent token dimension', () => {
    const span: TraceSpan = {
      spanId: 'span-agent',
      traceId: 'trace-1',
      name: 'llm.call',
      startTime: Date.now(),
      attributes: {
        'cost.dimension': 'agent',
        'cost.entity': 'agent-reviewer',
        'cost.value': 2500,
        'tenant.id': 't2',
      },
      events: [],
      status: 'ok',
    };
    const entry = CostMetricService.fromSpan(span);
    expect(entry!.dimension).toBe('agent');
    expect(entry!.value).toBe(2500);
    expect(entry!.unit).toBe('token');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// G3-3 AuditEnvelope → CostEntry
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('G3-3 fromAudit', () => {
  const makeEnvelope = (action: string): AuditEnvelope => ({
    envelopeId: 'env-1',
    tenantId: 't1',
    principalId: 'p1',
    principalType: 'user',
    action,
    resource: 'gate/prod',
    evidenceId: 'ev-1',
    traceSpanId: 'span-1',
    result: 'success',
    timestamp: '2026-09-09T00:00:00Z',
    metadata: {},
  });

  it('G3-3-1: gate.action produces gate dimension entry', () => {
    const entry = CostMetricService.fromAudit(makeEnvelope('gate.evaluate'));
    expect(entry).not.toBeNull();
    expect(entry!.dimension).toBe('gate');
    expect(entry!.value).toBe(1);
    expect(entry!.unit).toBe('eval');
  });

  it('G3-3-2: non-gate action returns null', () => {
    expect(CostMetricService.fromAudit(makeEnvelope('tool.echo'))).toBeNull();
    expect(CostMetricService.fromAudit(makeEnvelope('run.create'))).toBeNull();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// G3-4 定价策略热更新
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('G3-4 PricingPolicy 热更新', () => {
  let service: CostMetricService;

  beforeEach(() => {
    service = new CostMetricService();
  });

  it('G3-4-1: setPricingPolicy changes rates', () => {
    service.setPricingPolicy({ rates: { runner: 0.001, agent: 0.0001 } });
    const policy = service.getPricingPolicy();
    expect(policy.rates['runner']).toBe(0.001);
    expect(policy.rates['agent']).toBe(0.0001);
  });

  it('G3-4-2: tenantDiscount reduces totalUsd', () => {
    service.setPricingPolicy({
      rates: { runner: 1.0 },
      tenantDiscount: { t1: 0.5 },
    });
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 100, unit: 'ms', timestamp: '2026-09-09T00:00:00Z' });
    const usd = service.toUsd([
      { tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 100, unit: 'ms', timestamp: '2026-09-09T00:00:00Z' },
    ]);
    expect(usd).toBeCloseTo(50.0, 4); // 100 * 1.0 * 0.5
  });

  it('G3-4-3: unknown tenant gets no discount', () => {
    service.setPricingPolicy({
      rates: { runner: 1.0 },
      tenantDiscount: { t1: 0.5 },
    });
    const usd = service.toUsd([
      { tenantId: 't2', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 100, unit: 'ms', timestamp: '2026-09-09T00:00:00Z' },
    ]);
    expect(usd).toBeCloseTo(100.0, 4); // 无折扣
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// G3-5 skillId 归因增强
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('G3-5 skillId 归因', () => {
  let service: CostMetricService;

  beforeEach(() => {
    service = new CostMetricService();
    service.clear();
    service.setPricingPolicy({ rates: { runner: 0.001, agent: 0.0001, gate: 0.01 } });
  });

  it('G3-5-1: getSkillCostSummary 按 skillId 正确汇总成本', () => {
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 5000, unit: 'ms', timestamp: '2026-09-09T00:00:00Z', skillId: 'skill-auth' });
    service.record({ tenantId: 't1', dimension: 'gate', entityId: 'g1', metricName: 'cost.gate', value: 3, unit: 'eval', timestamp: '2026-09-09T00:01:00Z', skillId: 'skill-auth' });

    const summary = service.getSkillCostSummary({
      skillId: 'skill-auth',
      tenantId: 't1',
      from: '2026-09-01T00:00:00Z',
      to: '2026-09-30T23:59:59Z',
    });

    expect(summary.skillId).toBe('skill-auth');
    expect(summary.entryCount).toBe(2);
    expect(summary.byDimension['runner'].totalValue).toBe(5000);
    expect(summary.byDimension['runner'].count).toBe(1);
    expect(summary.byDimension['gate'].totalValue).toBe(3);
    expect(summary.byDimension['gate'].count).toBe(1);
    // runner: 5000*0.001 + gate: 3*0.01 = 5.0 + 0.03 = 5.03
    expect(summary.totalUsd).toBeCloseTo(5.03, 4);
  });

  it('G3-5-2: 多 skill 归因各自独立，互不干扰', () => {
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 1000, unit: 'ms', timestamp: '2026-09-09T00:00:00Z', skillId: 'skill-a' });
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r2', metricName: 'cost.runner', value: 2000, unit: 'ms', timestamp: '2026-09-09T00:01:00Z', skillId: 'skill-b' });
    service.record({ tenantId: 't1', dimension: 'agent', entityId: 'a1', metricName: 'cost.agent', value: 500, unit: 'token', timestamp: '2026-09-09T00:02:00Z', skillId: 'skill-a' });

    const sa = service.getSkillCostSummary({ skillId: 'skill-a', tenantId: 't1', from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' });
    const sb = service.getSkillCostSummary({ skillId: 'skill-b', tenantId: 't1', from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' });

    expect(sa.skillId).toBe('skill-a');
    expect(sa.entryCount).toBe(2);
    expect(sa.byDimension['runner'].totalValue).toBe(1000);
    expect(sa.byDimension['agent'].totalValue).toBe(500);
    expect(sb.skillId).toBe('skill-b');
    expect(sb.entryCount).toBe(1);
    expect(sb.byDimension['runner'].totalValue).toBe(2000);
    expect(sb.byDimension['agent']).toBeUndefined();
  });

  it('G3-5-3: 跨租户隔离（不同 tenantId 的同一 skillId 成本不混入）', () => {
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 1000, unit: 'ms', timestamp: '2026-09-09T00:00:00Z', skillId: 'shared-skill' });
    service.record({ tenantId: 't2', dimension: 'runner', entityId: 'r2', metricName: 'cost.runner', value: 9999, unit: 'ms', timestamp: '2026-09-09T00:01:00Z', skillId: 'shared-skill' });

    const t1Result = service.getSkillCostSummary({ skillId: 'shared-skill', tenantId: 't1', from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' });
    const t2Result = service.getSkillCostSummary({ skillId: 'shared-skill', tenantId: 't2', from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' });

    expect(t1Result.tenantId).toBe('t1');
    expect(t1Result.entryCount).toBe(1);
    expect(t1Result.byDimension['runner'].totalValue).toBe(1000);
    expect(t2Result.tenantId).toBe('t2');
    expect(t2Result.entryCount).toBe(1);
    expect(t2Result.byDimension['runner'].totalValue).toBe(9999);
  });

  it('G3-5-4: 无 skillId 记录在 skill 查询中不出现', () => {
    // 记录不带 skillId 的数据
    service.record({ tenantId: 't1', dimension: 'runner', entityId: 'r1', metricName: 'cost.runner', value: 500, unit: 'ms', timestamp: '2026-09-09T00:00:00Z' });
    service.record({ tenantId: 't1', dimension: 'agent', entityId: 'a1', metricName: 'cost.agent', value: 200, unit: 'token', timestamp: '2026-09-09T00:01:00Z', skillId: 'skill-x' });

    const withSkill = service.getSkillCostSummary({ skillId: 'skill-x', tenantId: 't1', from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' });
    const withoutSkill = service.getSkillCostSummary({ skillId: 'no-such-skill', tenantId: 't1', from: '2026-09-01T00:00:00Z', to: '2026-09-30T23:59:59Z' });

    expect(withSkill.entryCount).toBe(1);
    expect(withSkill.byDimension['agent'].totalValue).toBe(200);
    expect(withoutSkill.entryCount).toBe(0);
    expect(Object.keys(withoutSkill.byDimension).length).toBe(0);
  });
});
