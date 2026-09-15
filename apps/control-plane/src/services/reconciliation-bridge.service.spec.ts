import { Test, TestingModule } from '@nestjs/testing';
import { ReconciliationBridgeService } from './reconciliation-bridge.service';
import { BillingEngineService } from './billing-engine.service';
import { SettlementService } from './settlement-service';
import { SplitEngineService } from './split-engine.service';
import { MeteringService } from './metering.service';
import { CertifiedSkillPricingService } from './certified-skill-pricing.service';
import { PolicyPackExclusiveService } from './policy-pack-exclusive.service';
import { type MonthlyBill, type MeteringRecord } from '@aegisci/shared/types';

describe('ReconciliationBridgeService (K20-3)', () => {
  let bridge: ReconciliationBridgeService;
  let billingEngine: BillingEngineService;
  let settlementService: SettlementService;
  let splitEngine: SplitEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ReconciliationBridgeService,
        BillingEngineService,
        SettlementService,
        SplitEngineService,
        MeteringService,
        CertifiedSkillPricingService,
        PolicyPackExclusiveService,
      ],
    }).compile();
    bridge = module.get<ReconciliationBridgeService>(ReconciliationBridgeService);
    billingEngine = module.get<BillingEngineService>(BillingEngineService);
    settlementService = module.get<SettlementService>(SettlementService);
    splitEngine = module.get<SplitEngineService>(SplitEngineService);
  });

  afterEach(() => {
    billingEngine.clear();
    settlementService.clear();
    splitEngine.clear();
  });

  // ── verifyBillingConsistency ──

  describe('verifyBillingConsistency', () => {
    it('returns consistent report for normal flow', () => {
      // 计量 → 结算 → 分账 完整链路
      billingEngine.recordCall({
        recordId: 'm-1',
        tenantId: 'tenant-1',
        skillId: 'skill-a',
        callAt: '2026-01-15T10:00:00Z',
        durationMs: 100,
        cost: 125.0,
        usageType: 'tool',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      } as MeteringRecord);

      const bill: MonthlyBill = {
        billId: 'bill-1',
        tenantId: 'tenant-1',
        period: '2026-01',
        totalCalls: 1,
        totalCost: 125.0,
        lineItems: [{ skillId: 'skill-a', name: 'Skill A', calls: 1, unitPrice: 125, subtotal: 125.0 }],
        status: 'finalized',
        createdAt: '2026-01-31T00:00:00Z',
      };
      const settlement = settlementService.generateSettlement(bill);
      settlementService.approveSettlement(settlement.settlementId);

      const report = bridge.verifyBillingConsistency('tenant-1', '2026-01');
      expect(report.tenantId).toBe('tenant-1');
      expect(report.checkedAt).toBeDefined();
      // 正常流程下不应有 discrepancy
      expect(report.discrepancies).toHaveLength(0);
    });

    it('returns empty report for tenant with no data', () => {
      const report = bridge.verifyBillingConsistency('tenant-empty');
      expect(report.meteringCount).toBe(0);
      expect(report.billCallCount).toBe(0);
      expect(report.costMatch).toBe(true);
      expect(report.discrepancies).toHaveLength(0);
    });

    it('detects cost mismatch when billing and settlement differ', () => {
      billingEngine.recordCall({
        recordId: 'm-1',
        tenantId: 'tenant-1',
        skillId: 'skill-a',
        callAt: '2026-01-15T10:00:00Z',
        durationMs: 100,
        cost: 200.0,
        usageType: 'tool',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      } as MeteringRecord);

      // 手动设置一个不同的结算金额
      const bill: MonthlyBill = {
        billId: 'bill-1',
        tenantId: 'tenant-1',
        period: '2026-01',
        totalCalls: 1,
        totalCost: 500.0,
        lineItems: [{ skillId: 'skill-a', name: 'Skill A', calls: 1, unitPrice: 500, subtotal: 500.0 }],
        status: 'finalized',
        createdAt: '2026-01-31T00:00:00Z',
      };
      const settlement = settlementService.generateSettlement(bill);
      settlementService.approveSettlement(settlement.settlementId);

      const report = bridge.verifyBillingConsistency('tenant-1');
      expect(report).toBeDefined();
      expect(report.costMatch).toBe(false);
      expect(report.discrepancies.some(d => d.type === 'cost_mismatch')).toBe(true);
    });

    it('verifies tenant isolation', () => {
      billingEngine.recordCall({
        recordId: 'm-1',
        tenantId: 'tenant-a',
        skillId: 'skill-a',
        callAt: '2026-01-15T10:00:00Z',
        durationMs: 100,
        cost: 5.0,
        usageType: 'tool',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      } as MeteringRecord);

      billingEngine.recordCall({
        recordId: 'm-2',
        tenantId: 'tenant-b',
        skillId: 'skill-b',
        callAt: '2026-01-15T10:00:00Z',
        durationMs: 100,
        cost: 3.0,
        usageType: 'tool',
        evidenceId: 'ev-2',
        traceSpanId: 'span-2',
      } as MeteringRecord);

      const reportA = bridge.verifyBillingConsistency('tenant-a');
      const reportB = bridge.verifyBillingConsistency('tenant-b');

      expect(reportA.tenantId).toBe('tenant-a');
      expect(reportB.tenantId).toBe('tenant-b');
      expect(reportA.meteringCount).toBe(1);
      expect(reportB.meteringCount).toBe(1);
    });
  });

  // ── generateDiscrepancyReport ──

  describe('generateDiscrepancyReport', () => {
    it('returns empty array when no discrepancies', () => {
      // 先记录计量
      billingEngine.recordCall({
        recordId: 'm-1',
        tenantId: 'tenant-1',
        skillId: 'skill-a',
        callAt: '2026-01-15T10:00:00Z',
        durationMs: 100,
        cost: 200.0,
        usageType: 'tool',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      } as MeteringRecord);

      const bill: MonthlyBill = {
        billId: 'bill-1',
        tenantId: 'tenant-1',
        period: '2026-01',
        totalCalls: 1,
        totalCost: 200.0,
        lineItems: [{ skillId: 'skill-a', name: 'A', calls: 1, unitPrice: 200, subtotal: 200.0 }],
        status: 'finalized',
        createdAt: '2026-01-31T00:00:00Z',
      };
      const settlement = settlementService.generateSettlement(bill);
      settlementService.approveSettlement(settlement.settlementId);

      const discrepancies = bridge.generateDiscrepancyReport('tenant-1');
      expect(discrepancies).toHaveLength(0);
    });
  });
});
