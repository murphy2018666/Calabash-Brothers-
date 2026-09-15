import { Test, TestingModule } from '@nestjs/testing';
import { BillingEngineService } from '../services/billing-engine.service';
import { MeteringService } from '../services/metering.service';
import { BillingService } from '../services/billing-service';
import { MeteringCollectorService } from '../services/metering-collector.service';
import { MeteringAuditGuard } from '../guards/metering-audit.guard';
import { BillingController } from './billing.controller';
import { CertifiedSkillPricingService } from '../services/certified-skill-pricing.service';
import { PolicyPackExclusiveService } from '../services/policy-pack-exclusive.service';
import { ToolCallResult, Principal } from '@aegisci/shared/types';

describe('K10 Billing Engine (S20)', () => {
  let engine: BillingEngineService;
  let metering: MeteringService;
  let exclusivePackService: PolicyPackExclusiveService;
  let collector: MeteringCollectorService;
  let billingService: BillingService;
  let guard: MeteringAuditGuard;
  let controller: BillingController;
  let pricingService: CertifiedSkillPricingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingEngineService,
        MeteringService,
        CertifiedSkillPricingService,
        PolicyPackExclusiveService,
        MeteringCollectorService,
        BillingService,
        MeteringAuditGuard,
        {
          provide: BillingController,
          useFactory: (bs: BillingService, mc: MeteringCollectorService) =>
            new BillingController(bs, mc),
          inject: [BillingService, MeteringCollectorService],
        },
      ],
    }).compile();

    engine = module.get(BillingEngineService);
    metering = module.get(MeteringService);
    pricingService = module.get(CertifiedSkillPricingService);
    exclusivePackService = module.get(PolicyPackExclusiveService);
    collector = module.get(MeteringCollectorService);
    billingService = module.get(BillingService);
    guard = module.get(MeteringAuditGuard);
    controller = module.get(BillingController);
  });

  afterEach(() => {
    engine.clear();
  });

  // ── K10-1: 计费引擎核心 ──

  it.each([
    { tier: 'free' as const, expected: 0 },
  ])('free tier → cost = $expected', ({ expected }) => {
    const record = makeRecord('tenant-1', 'skill-1');
    const cost = engine.calcCost(record, { tier: 'free' });
    expect(cost).toBe(expected);
  });

  it.each([
    { durationMs: 100, perCallPrice: 0.01, expected: 1 },
    { durationMs: 50, perCallPrice: 0.02, expected: 1 },
  ])('usage tier → cost = perCallPrice × durationMs ($durationMs ms × $perCallPrice)', ({ durationMs, perCallPrice, expected }) => {
    const record = makeRecord('tenant-1', 'skill-1', { durationMs });
    const cost = engine.calcCost(record, { tier: 'usage', perCallPrice });
    expect(cost).toBe(expected);
  });

  it('freemium: within quota → cost = 0', () => {
    engine.recordCall(makeRecord('tenant-1', 'skill-1', { evidenceId: 'e1', callAt: '2026-01-01T00:00:01Z' }));
    engine.recordCall(makeRecord('tenant-1', 'skill-1', { evidenceId: 'e2', callAt: '2026-01-01T00:00:02Z' }));
    const record = makeRecord('tenant-1', 'skill-1', {
      evidenceId: 'e3', callAt: '2026-01-01T00:00:03Z',
    });
    const cost = engine.calcCost(record, { tier: 'freemium', monthlyQuota: 100, perCallPrice: 0.01 });
    expect(cost).toBe(0);
  });

  it('subscription: base fee + overage', () => {
    for (let i = 1; i <= 10; i++) {
      engine.recordCall(makeRecord('tenant-1', 'skill-1', {
        evidenceId: `e${i}`, callAt: `2026-01-01T00:00:0${i}Z`,
      }));
    }
    const record = makeRecord('tenant-1', 'skill-1', {
      evidenceId: 'e11', callAt: '2026-01-01T00:00:11Z',
    });
    engine.recordCall(record);
    const cost = engine.calcCost(record, { tier: 'subscription', monthlyQuota: 10, overagePrice: 0.5 });
    expect(cost).toBe(0.5);
  });

  it('idempotency: same evidenceId not double-counted', () => {
    const record = makeRecord('tenant-1', 'skill-1', { evidenceId: 'dup-1' });
    engine.recordCall(record);
    engine.recordCall(record);
    const records = engine.getMetering('tenant-1');
    expect(records).toHaveLength(1);
  });

  it.each([
    { desc: 'recordCall writes to MeteringService', skillId: 'skill-a', expected: 1 },
    { desc: 'duplicate recordCall skipped', skillId: 'skill-b', expected: 1 },
  ])('$desc', ({ skillId, expected }) => {
    if (skillId === 'skill-b') {
      engine.recordCall(makeRecord('tenant-1', skillId, { evidenceId: 'ev-idempotent' }));
      engine.recordCall(makeRecord('tenant-1', skillId, { evidenceId: 'ev-idempotent' }));
    } else {
      engine.recordCall(makeRecord('tenant-1', skillId, { evidenceId: 'ev-write-test' }));
    }
    const found = engine.getMetering('tenant-1');
    expect(found).toHaveLength(expected);
  });

  it('getMetering filters by time range', () => {
    engine.recordCall(makeRecord('tenant-1', 'skill-1', { callAt: '2026-01-01T00:00:00Z' }));
    engine.recordCall(makeRecord('tenant-1', 'skill-1', { callAt: '2026-02-01T00:00:00Z' }));
    const janRecords = engine.getMetering('tenant-1', undefined, '2026-01-01', '2026-01-31');
    expect(janRecords).toHaveLength(1);
  });

  it('generateBill summarizes records by skill', () => {
    engine.clear();
    engine.recordCall(makeRecord('tenant-1', 'skill-a', { cost: 10 }));
    engine.recordCall(makeRecord('tenant-1', 'skill-a', { cost: 20 }));
    engine.recordCall(makeRecord('tenant-1', 'skill-b', { cost: 5 }));
    const bill = engine.generateBill('tenant-1', '2026-01');
    expect(bill.totalCalls).toBe(3);
    expect(bill.totalCost).toBe(35);
    expect(bill.lineItems).toHaveLength(2);
  });

  it('generateBill returns draft status', () => {
    engine.clear();
    engine.recordCall(makeRecord('tenant-1', 'skill-1'));
    const bill = engine.generateBill('tenant-1', '2026-01');
    expect(bill.status).toBe('draft');
  });

  // ── K10-1: 付费定价集成（K19-2） ──

  it.each([
    { period: 'monthly' as const, price: 99.99, expectedCalls: 5, expectedCost: 0 },
    { period: 'yearly' as const, price: 999.99, expectedCalls: 5, expectedCost: 0 },
    { period: 'perpetual' as const, price: 499.99, expectedCalls: 5, expectedCost: 0 },
  ])('generateBill: paid plan (%s, price=$%d) → subscription with free tier', ({ period, price, expectedCalls, expectedCost }) => {
    engine.clear();
    pricingService.createPricingPlan('skill-paid', 'tenant-paid', period, price);

    for (let i = 1; i <= expectedCalls; i++) {
      engine.recordCall(makeRecord('tenant-paid', 'skill-paid', { cost: 0 }));
    }
    const bill = engine.generateBill('tenant-paid', '2026-01');
    expect(bill.totalCalls).toBe(expectedCalls);
    expect(bill.totalCost).toBe(expectedCost);
    expect(bill.lineItems[0].skillId).toBe('skill-paid');
  });

  it('getPricingPlan: returns null for skill without pricing', () => {
    const result = engine.getPricingPlan('tenant-no-plan', 'skill-no-plan');
    expect(result).toBeNull();
  });

  it('getPricingPlan: returns subscription model for paid skill', () => {
    pricingService.createPricingPlan('skill-pro', 'tenant-pro', 'monthly', 49.99);
    const plan = engine.getPricingPlan('tenant-pro', 'skill-pro');
    expect(plan).toBeDefined();
    expect(plan!.tier).toBe('subscription');
  });

  // ── K10-2: 计量采集器 ──

  it('writes metering record on tool call', async () => {
    const result: ToolCallResult = {
      success: true, data: { skillId: 'skill-1' },
      evidenceId: 'ev-col-1', traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'user-1', type: 'user', tenantId: 'tenant-1', roles: ['admin'],
    };
    await collector.onToolCall(result, principal, 'run-1');
    const records = engine.getMetering('tenant-1');
    expect(records).toHaveLength(1);
    expect(records[0].evidenceId).toBe('ev-col-1');
  });

  it('does not throw when BillingEngine fails', async () => {
    const originalRecordCall = engine.recordCall.bind(engine);
    engine.recordCall = jest.fn().mockImplementation(() => { throw new Error('store full'); });
    const result: ToolCallResult = {
      success: true, data: { skillId: 'skill-1' },
      evidenceId: 'ev-safe-1', traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'user-1', type: 'user', tenantId: 'tenant-1', roles: ['admin'],
    };
    await expect(collector.onToolCall(result, principal, 'run-2')).resolves.toBeUndefined();
    engine.recordCall = originalRecordCall;
  });

  it('uses evidenceId as metering record identifier', async () => {
    const result: ToolCallResult = {
      success: true, data: { skillId: 'skill-db' },
      evidenceId: 'ev-evidence-test', traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'u1', type: 'service', tenantId: 't1', roles: ['reader'],
    };
    await collector.onToolCall(result, principal, 'run-evidence');
    const records = engine.getMetering('t1');
    expect(records).toHaveLength(1);
    expect(records[0].evidenceId).toBe('ev-evidence-test');
  });

  it('sets callAt to current ISO timestamp', async () => {
    const before = new Date().toISOString();
    const result: ToolCallResult = {
      success: true, data: { skillId: 'skill-1' },
      evidenceId: 'ev-time-1', traceSpanId: 'span-1',
    };
    const principal: Principal = { id: 'u1', type: 'user', tenantId: 't1', roles: [] };
    await collector.onToolCall(result, principal, 'run-time');
    const records = engine.getMetering('t1');
    expect(records[0].callAt >= before).toBe(true);
  });

  it.each([
    { type: 'user' as const, desc: 'user principal' },
    { type: 'agent' as const, desc: 'agent principal' },
  ])('works with $desc', async ({ type }) => {
    const result: ToolCallResult = {
      success: true, data: { skillId: 'skill-agent' },
      evidenceId: 'ev-agent-1', traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: `agent-${type}-1`, type, tenantId: 'tenant-prod', roles: ['planner'],
    };
    await collector.onToolCall(result, principal, 'run-agent');
    const records = engine.getMetering('tenant-prod');
    expect(records).toHaveLength(1);
    expect(records[0].tenantId).toBe('tenant-prod');
  });

  // ── K10-2: 计量采集守卫 ──

  it('triggers collector on tool call success', async () => {
    const spy = jest.spyOn(collector, 'onToolCall').mockResolvedValue(undefined);
    const result: ToolCallResult = {
      success: true, data: { skillId: 'skill-1' },
      evidenceId: 'ev-guard-1', traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'user-1', type: 'user', tenantId: 'tenant-1', roles: ['admin'],
    };
    await guard.onToolCallSuccess(result, principal, 'run-3');
    expect(spy).toHaveBeenCalledWith(result, principal, 'run-3');
  });

  // ── K10-3: BillingService ──

  it.each([
    { desc: 'getMetering returns paginated results', page: 1, pageSize: 3, expected: 3, total: 5 },
    { desc: 'getMetering returns remaining on page 2', page: 2, pageSize: 3, expected: 2, total: 5 },
  ])('$desc', ({ page, pageSize, expected, total }) => {
    for (let i = 0; i < 5; i++) engine.recordCall(makeRecord('tenant-1', 'skill-1'));
    const result = billingService.getMetering('tenant-1', undefined, undefined, undefined, page, pageSize);
    expect(result.records).toHaveLength(expected);
    expect(result.total).toBe(total);
  });

  it('exportBillCsv returns valid CSV', () => {
    engine.recordCall(makeRecord('tenant-1', 'skill-a', { cost: 10 }));
    const bill = engine.generateBill('tenant-1', '2026-01');
    const csv = billingService.exportBillCsv(bill);
    expect(csv).toContain('skillId');
    expect(csv).toContain('skill-a');
    expect(csv).toContain('10');
  });

  it('exportBillJson returns valid JSON', () => {
    engine.recordCall(makeRecord('tenant-1', 'skill-a', { cost: 10 }));
    const bill = engine.generateBill('tenant-1', '2026-01');
    const parsed = JSON.parse(billingService.exportBillJson(bill));
    expect(parsed.tenantId).toBe('tenant-1');
    expect(parsed.period).toBe('2026-01');
  });

  it('getPricingTiers returns all four tiers', () => {
    expect(billingService.getPricingTiers()).toEqual(['free', 'freemium', 'subscription', 'usage']);
  });

  it.each([
    { desc: 'getStats returns aggregate calls and cost', cost1: 5, cost2: 15, expCalls: 2, expCost: 20 },
    { desc: 'getStats handles zero cost', cost1: 0, cost2: 0, expCalls: 2, expCost: 0 },
  ])('$desc', ({ cost1, cost2, expCalls, expCost }) => {
    engine.clear();
    engine.recordCall(makeRecord('tenant-1', 'skill-1', { cost: cost1 }));
    engine.recordCall(makeRecord('tenant-1', 'skill-1', { cost: cost2 }));
    const stats = billingService.getStats('tenant-1');
    expect(stats.totalCalls).toBe(expCalls);
    expect(stats.totalCost).toBe(expCost);
  });

  it('getTopSkills sorts by call count descending', () => {
    for (let i = 0; i < 5; i++) engine.recordCall(makeRecord('tenant-1', 'skill-a'));
    for (let i = 0; i < 3; i++) engine.recordCall(makeRecord('tenant-1', 'skill-b'));
    const top = billingService.getTopSkills('tenant-1', 2);
    expect(top[0].skillId).toBe('skill-a');
    expect(top[0].calls).toBe(5);
    expect(top[1].skillId).toBe('skill-b');
    expect(top[1].calls).toBe(3);
  });

  // ── K10-3: BillingController ──

  it.each([
    { desc: 'GET pricing-tiers', method: 'pricingTiers' as const, expected: ['free', 'freemium', 'subscription', 'usage'] },
  ])('$desc', ({ method, expected }) => {
    const result = (controller as any)[method]();
    expect(result).toEqual(expected);
  });

  it('GET /api/billing/stats returns stats', () => {
    engine.recordCall(makeRecord('tenant-1', 'skill-1'));
    const stats = controller.stats('tenant-1');
    expect(stats.totalCalls).toBe(1);
  });
});

// ── 辅助函数 ──

let _recordCounter = 0;

function makeRecord(
  tenantId: string,
  skillId: string,
  overrides: Partial<{
    evidenceId: string;
    callAt: string;
    durationMs: number;
    cost: number;
  }> = {},
): import('@aegisci/shared/types').MeteringRecord {
  _recordCounter += 1;
  return {
    recordId: `rec_${_recordCounter}_${Math.random().toString(36).slice(2, 6)}`,
    tenantId,
    skillId,
    callAt: overrides.callAt ?? '2026-01-15T10:00:00Z',
    durationMs: overrides.durationMs ?? 1,
    cost: overrides.cost ?? 0,
    usageType: 'tool',
    evidenceId: overrides.evidenceId ?? `ev_${_recordCounter}_${skillId}`,
    traceSpanId: `span_${_recordCounter}`,
  };
}
