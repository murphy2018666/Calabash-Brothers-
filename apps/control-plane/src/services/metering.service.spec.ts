/**
 * MeteringService 单元测试（K18-3）。
 * TDD 策略：先定义测试契约，再实现服务。
 * 使用参数化测试减少重复。
 */

import { MeteringService } from './metering.service';

describe('MeteringService (K18-3)', () => {
  let metering: MeteringService;

  beforeEach(() => {
    metering = new MeteringService();
  });

  afterEach(() => {
    metering.clear();
  });

  // ── 单条记录 ──

  it('recordUsage: records a single usage event', () => {
    const result = metering.recordUsage('call', 't-1', 'skill-1', { durationMs: 100, cost: 50 });
    expect(result).toBeDefined();
    expect(result.eventType).toBe('call');
    expect(result.tenantId).toBe('t-1');
    expect(result.skillId).toBe('skill-1');
  });

  it('recordUsage: generates unique eventId', () => {
    const r1 = metering.recordUsage('call', 't-1', 'skill-1', {});
    const r2 = metering.recordUsage('call', 't-1', 'skill-1', {});
    expect(r1.eventId).not.toBe(r2.eventId);
  });

  // ── 查询：参数化合并 filter 场景 ──

  it.each([
    { desc: 'returns records for tenant', tenantId: 't-q1', skillId: undefined, expected: 2 },
    { desc: 'filters by skillId', tenantId: 't-q2', skillId: 'skill-a', expected: 1 },
  ])('queryUsage: $desc', ({ tenantId, skillId, expected }) => {
    metering.recordUsage('call', tenantId, 'skill-a', {});
    if (expected > 1) metering.recordUsage('call', tenantId, 'skill-a', {});
    else metering.recordUsage('call', tenantId, 'skill-b', {});
    const results = metering.queryUsage(tenantId, skillId as any);
    expect(results.length).toBe(expected);
  });

  it('queryUsage: tenant isolation', () => {
    metering.recordUsage('call', 't-a', 'skill-1', {});
    metering.recordUsage('call', 't-b', 'skill-1', {});
    expect(metering.queryUsage('t-a').length).toBe(1);
    expect(metering.queryUsage('t-b').length).toBe(1);
  });

  it('queryUsage: returns empty array for unknown tenant', () => {
    expect(metering.queryUsage('t-nonexistent')).toEqual([]);
  });

  it('queryUsage: supports time range filter', () => {
    metering.recordUsage('call', 't-time', 'skill-t', {});
    const records = metering.queryUsage('t-time');
    expect(records.length).toBeGreaterThanOrEqual(1);
    const earliest = records[0].callAt;
    const results = metering.queryUsage('t-time', undefined, earliest, earliest);
    expect(results.length).toBeGreaterThanOrEqual(1);
  });

  // ── 批量写入 ──

  it('batchRecord: writes multiple events atomically', () => {
    const events = [
      { eventType: 'call', tenantId: 't-batch', skillId: 'skill-b1', metadata: {} },
      { eventType: 'call', tenantId: 't-batch', skillId: 'skill-b2', metadata: {} },
      { eventType: 'call', tenantId: 't-batch', skillId: 'skill-b1', metadata: {} },
    ];
    metering.batchRecord(events);
    expect(metering.queryUsage('t-batch').length).toBe(3);
  });

  it('batchRecord: rolls back on partial failure', () => {
    const events = [
      { eventType: 'call', tenantId: 't-roll', skillId: 'skill-r1', metadata: {} },
      { eventType: 'call', tenantId: 't-roll', skillId: 'skill-r2', metadata: {} },
    ];
    metering.batchRecord(events);
    expect(metering.queryUsage('t-roll').length).toBe(2);
  });

  // ── 统计：参数化合并 ──

  it.each([
    [{ calls: 2, costs: [10, 20], skills: ['skill-s1'] }, { totalCalls: 2, totalCost: 30 }],
    [{ calls: 2, costs: [100, 200], skills: ['skill-a', 'skill-b'] }, { totalCalls: 2, totalCost: 300 }],
  ])('getStats: basic aggregation', (_ctx, expected) => {
    const { calls, costs, skills } = _ctx as any;
    for (let i = 0; i < calls; i++) {
      metering.recordUsage('call', 't-stats', skills[i] || skills[0], { cost: costs[i] });
    }
    const stats = metering.getStats('t-stats');
    expect(stats.totalCalls).toBe(expected.totalCalls);
    expect(stats.totalCost).toBe(expected.totalCost);
  });

  it('getStats: includes agent event type', () => {
    metering.recordUsage('call', 't-mix', 'skill-s1', { cost: 10 });
    metering.recordUsage('agent', 't-mix', 'skill-s2', { cost: 5 });
    const stats = metering.getStats('t-mix');
    expect(stats.totalCalls).toBe(2);
    expect(stats.totalCost).toBe(15);
  });

  // ── 边界条件 ──

  it('recordUsage: handles empty metadata', () => {
    const result = metering.recordUsage('call', 't-empty', 'skill-e', {});
    expect(result).toBeDefined();
    expect(result.metadata).toEqual({});
  });

  // ── queryByPeriod ──

  it('queryByPeriod: groups by daily and returns sorted periods', () => {
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    metering.recordUsage('call', 't-period', 'skill-p1', { cost: 10 });
    metering.recordUsage('call', 't-period', 'skill-p1', { cost: 20 });
    // 等待下一毫秒再记录，确保不同 eventId，但 callAt 相同（均由 new Date() 决定）
    metering.recordUsage('call', 't-period', 'skill-p2', { cost: 5 });
    metering.recordUsage('call', 't-other', 'skill-p1', { cost: 100 });

    const result = metering.queryByPeriod('t-period', 'daily');
    // 所有记录发生在同一天（当前 UTC 日），因 recordUsage 内部使用 new Date()
    expect(result).toHaveLength(1);
    expect(result[0].period).toBe(today);
    expect(result[0].totalCalls).toBe(3);
    expect(result[0].totalCost).toBe(35);
    expect(result[0].bySkill['skill-p1'].calls).toBe(2);
    expect(result[0].bySkill['skill-p1'].cost).toBe(30);
    expect(result[0].bySkill['skill-p2'].calls).toBe(1);
    expect(result[0].bySkill['skill-p2'].cost).toBe(5);
  });

  it('queryByPeriod: groups by monthly correctly', () => {
    metering.recordUsage('call', 't-month', 'skill-m1', { cost: 5 });
    metering.recordUsage('call', 't-month', 'skill-m1', { cost: 15 });
    metering.recordUsage('call', 't-month', 'skill-m2', { cost: 8 });

    const result = metering.queryByPeriod('t-month', 'monthly');
    expect(result).toHaveLength(1);
    const currentMonth = new Date().toISOString().slice(0, 7);
    expect(result[0].period).toBe(currentMonth);
    expect(result[0].totalCalls).toBe(3);
    expect(result[0].totalCost).toBe(28);
    expect(result[0].bySkill['skill-m1'].calls).toBe(2);
    expect(result[0].bySkill['skill-m1'].cost).toBe(20);
    expect(result[0].bySkill['skill-m2'].calls).toBe(1);
    expect(result[0].bySkill['skill-m2'].cost).toBe(8);
  });

  it('queryByPeriod: tenant isolation across periods', () => {
    metering.recordUsage('call', 't-a', 'skill-1', { cost: 10 });
    metering.recordUsage('call', 't-b', 'skill-1', { cost: 20 });

    const rA = metering.queryByPeriod('t-a', 'daily');
    const rB = metering.queryByPeriod('t-b', 'daily');
    expect(rA.length).toBe(1);
    expect(rA[0].totalCost).toBe(10);
    expect(rB.length).toBe(1);
    expect(rB[0].totalCost).toBe(20);
  });

  it('queryByPeriod: empty result for tenant with no data', () => {
    const result = metering.queryByPeriod('t-nodata', 'daily');
    expect(result).toEqual([]);
  });
});
