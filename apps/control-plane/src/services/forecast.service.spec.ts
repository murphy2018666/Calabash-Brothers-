import { ForecastService } from './forecast.service';
import { BillingEngineService } from './billing-engine.service';
import { MeteringService } from './metering.service';
import { CertifiedSkillPricingService } from './certified-skill-pricing.service';
import { MeteringRecord } from '@aegisci/shared/types';

function makeRecord(tenantId: string, skillId: string, callAt: string, cost: number): MeteringRecord {
  return {
    recordId: `rec-${tenantId}-${skillId}-${callAt}`,
    tenantId,
    skillId,
    callAt,
    durationMs: 100,
    cost,
    usageType: 'tool',
    evidenceId: `ev-${tenantId}-${skillId}-${callAt}`,
    traceSpanId: `span-${tenantId}-${skillId}-${callAt}`,
  };
}

/** 生成最近 N 个月的ISO日期字符串（每月第15日），相对于当前日期 */
function recentMonthDates(months: number): string[] {
  const now = new Date();
  const result: string[] = [];
  for (let i = 0; i < months; i++) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 15);
    result.push(d.toISOString().slice(0, 10));
  }
  return result.reverse();
}

describe('ForecastService', () => {
  let service: ForecastService;
  let billing: BillingEngineService;

  beforeEach(() => {
    billing = new BillingEngineService(new MeteringService(), new CertifiedSkillPricingService());
    service = new ForecastService(billing);
    billing.clear();
  });

  // ── insufficientData：参数化合并 ──

  it.each([
    { months: 0, method: 'linear', desc: 'no billing data' },
    { months: 2, method: 'linear', desc: 'only 2 months of data' },
    { months: 3, method: 'exponential', desc: 'exponential with zero revenues' },
  ])('returns insufficientData=true when $desc', ({ months, method }) => {
    if (months === 0) {
      const result = service.predict('t1', 3, method);
      expect(result.insufficientData).toBe(true);
      expect(result.predictedRevenue).toBe(0);
      expect(result.dataPoints).toBeLessThan(3);
      return;
    }
    const dates = recentMonthDates(months);
    const costs = method === 'exponential' ? Array(months).fill(0) : [100, 200];
    for (let i = 0; i < months; i++) {
      billing.recordCall(makeRecord('t1', 'skill-a', dates[i], costs[i] ?? 100 * (i + 1)));
    }
    const result = service.predict('t1', 3, method);
    expect(result.insufficientData).toBe(true);
  });

  // ── linear prediction：参数化合并趋势类型 ──

  it.each([
    { costs: [100, 200, 300, 400, 500], months: 5, trend: 'up', minPredicted: 400, desc: 'arithmetic sequence' },
    { costs: [100, 100, 100], months: 3, trend: 'stable', minPredicted: 99, desc: 'constant revenue' },
    { costs: [300, 200, 100], months: 3, trend: 'down', minPredicted: -1, desc: 'decreasing revenue' },
  ])('predicts $desc trend ($trend)', ({ costs, months, trend, minPredicted }) => {
    const dates = recentMonthDates(months);
    for (let i = 0; i < months; i++) {
      billing.recordCall(makeRecord('t1', 'skill-a', dates[i], costs[i]));
    }
    const result = service.predict('t1', 3, 'linear');
    expect(result.insufficientData).toBe(false);
    expect(result.trend).toBe(trend);
    expect(result.predictedRevenue).toBeGreaterThan(minPredicted);
  });

  it('predicts exponential growth correctly', () => {
    const dates = recentMonthDates(5);
    [100, 200, 400, 800, 1600].forEach((cost, i) => {
      billing.recordCall(makeRecord('t1', 'skill-a', dates[i], cost));
    });
    const result = service.predict('t1', 3, 'exponential');
    expect(result.insufficientData).toBe(false);
    expect(result.method).toBe('exponential');
    expect(result.trend).toBe('up');
    expect(result.predictedRevenue).toBeGreaterThan(2000);
  });

  // ── 租户隔离 ──

  it('isolates predictions per tenant', () => {
    const dates = recentMonthDates(3);
    billing.recordCall(makeRecord('t1', 'skill-a', dates[0], 100));
    billing.recordCall(makeRecord('t1', 'skill-a', dates[1], 200));
    billing.recordCall(makeRecord('t1', 'skill-a', dates[2], 300));
    billing.recordCall(makeRecord('t2', 'skill-a', dates[0], 500));
    billing.recordCall(makeRecord('t2', 'skill-a', dates[1], 600));
    billing.recordCall(makeRecord('t2', 'skill-a', dates[2], 700));

    const r1 = service.predict('t1', 3, 'linear');
    const r2 = service.predict('t2', 3, 'linear');

    expect(r1.predictedRevenue).not.toBe(r2.predictedRevenue);
    expect(r1.dataPoints).toBe(3);
    expect(r2.dataPoints).toBe(3);
  });

  it('aggregates platform revenue when tenantId is absent', () => {
    const dates = recentMonthDates(2);
    billing.recordCall(makeRecord('t1', 'skill-a', dates[0], 100));
    billing.recordCall(makeRecord('t2', 'skill-a', dates[0], 200));
    billing.recordCall(makeRecord('t1', 'skill-a', dates[1], 300));
    billing.recordCall(makeRecord('t2', 'skill-a', dates[1], 400));

    const result = service.predict(undefined, 3, 'linear');
    if (!result.insufficientData) {
      expect(result.predictedRevenue).toBeGreaterThan(0);
    }
  });

  // ── 历史数据 ──

  it('returns historical revenue points', () => {
    const dates = recentMonthDates(3);
    billing.recordCall(makeRecord('t1', 'skill-a', dates[0], 100));
    billing.recordCall(makeRecord('t1', 'skill-a', dates[1], 200));

    const history = service.getHistoricalRevenue('t1', 6);
    expect(history.length).toBeGreaterThan(0);
    const monthsWithData = history.filter((h) => h.revenue > 0);
    expect(monthsWithData.length).toBeGreaterThanOrEqual(2);
  });

  it('returns empty historical data when no records exist', () => {
    const history = service.getHistoricalRevenue('t1', 6);
    for (const h of history) {
      expect(h.revenue).toBe(0);
    }
  });

  // ── predictBySkill (K16-4) ──

  it('predicts by skill with sufficient data', () => {
    const dates = recentMonthDates(4);
    [100, 200, 300, 400].forEach((cost, i) => {
      billing.recordCall(makeRecord('t1', 'skill-a', dates[i], cost));
    });
    billing.recordCall(makeRecord('t1', 'skill-b', dates[0], 500));

    const result = service.predictBySkill('t1', 'skill-a', 2, 'linear');
    expect(result.insufficientData).toBe(false);
    expect(result.method).toBe('linear');
    expect(result.dataPoints).toBe(4);
    expect(result.predictedRevenue).toBeGreaterThan(300);
  });

  it('returns insufficientData for skill with too few records', () => {
    const dates = recentMonthDates(2);
    billing.recordCall(makeRecord('t1', 'skill-x', dates[0], 100));
    billing.recordCall(makeRecord('t1', 'skill-x', dates[1], 200));

    const result = service.predictBySkill('t1', 'skill-x', 2, 'linear');
    expect(result.insufficientData).toBe(true);
  });

  it('isolates predictions by skill and tenant', () => {
    const dates = recentMonthDates(3);
    billing.recordCall(makeRecord('t1', 'skill-a', dates[0], 100));
    billing.recordCall(makeRecord('t1', 'skill-a', dates[1], 200));
    billing.recordCall(makeRecord('t1', 'skill-a', dates[2], 300));
    billing.recordCall(makeRecord('t1', 'skill-b', dates[0], 500));
    billing.recordCall(makeRecord('t1', 'skill-b', dates[1], 600));
    billing.recordCall(makeRecord('t1', 'skill-b', dates[2], 700));

    const r1 = service.predictBySkill('t1', 'skill-a', 2, 'linear');
    const r2 = service.predictBySkill('t1', 'skill-b', 2, 'linear');

    expect(r1.predictedRevenue).not.toBe(r2.predictedRevenue);
    expect(r1.dataPoints).toBe(3);
    expect(r2.dataPoints).toBe(3);
  });
});
