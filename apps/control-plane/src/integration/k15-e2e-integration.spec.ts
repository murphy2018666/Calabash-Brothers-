import { PricingModelService } from '../services/pricing-model.service';
import { CommissionRateService } from '../services/commission-rate.service';
import { ReconciliationService, type Discrepancy } from '../services/reconciliation.service';
import { MarketDashboardService } from '../services/market-dashboard.service';
import { BillingEngineService } from '../services/billing-engine.service';
import { MeteringService } from '../services/metering.service';
import { CertifiedSkillPricingService } from '../services/certified-skill-pricing.service';
import { MeteringCollectorService } from '../services/metering-collector.service';
import { SettlementService } from '../services/settlement-service';
import { SplitEngineService } from '../services/split-engine.service';
import { SkillRatingService } from '../services/skill-rating.service';
import { DelistWarningService } from '../services/delist-warning.service';
import { CertificationEngineService } from '../services/certification-engine.service';
import { PolicyPackExclusiveService } from '../services/policy-pack-exclusive.service';
import { type MonthlyBill, type Settlement, type ToolCallResult } from '@aegisci/shared/types';

describe('K15 End-to-End Integration (S25)', () => {
  let pricing: PricingModelService;
  let commission: CommissionRateService;
  let reconciliation: ReconciliationService;
  let dashboard: MarketDashboardService;
  let billing: BillingEngineService;
  let metering: MeteringCollectorService;
  let settlement: SettlementService;
  let skillRating: SkillRatingService;
  let delistWarning: DelistWarningService;
  let certification: CertificationEngineService;
  let mockForecastService: any;

  beforeEach(() => {
    mockForecastService = { predict: jest.fn().mockReturnValue({ predictedRevenue: 0, method: 'linear', trend: 'stable', dataPoints: 0, lowerBound: 0, upperBound: 0, insufficientData: true }) };
    pricing = new PricingModelService();
    commission = new CommissionRateService();
    reconciliation = new ReconciliationService();
    const splitEngine = new SplitEngineService();
    const meteringSvc = new MeteringService();
    const pricingSvc = new CertifiedSkillPricingService();
    billing = new BillingEngineService(meteringSvc, pricingSvc);
    const exclusivePackService = new PolicyPackExclusiveService();
    metering = new MeteringCollectorService(billing, exclusivePackService);
    settlement = new SettlementService(splitEngine);
    skillRating = new SkillRatingService(null as any);
    delistWarning = new DelistWarningService();
    certification = new CertificationEngineService();
    dashboard = new MarketDashboardService(billing, settlement, skillRating, delistWarning, certification, mockForecastService);

    pricing.clear();
    commission.clear();
    reconciliation.clear();
    dashboard.clear();
    billing.clear();
  });

  // ── K15-5: 免费技能全流程（计费=0，无抽佣）──

  it('free tier: calcCost=0, hasQuota=true, commission=null', () => {
    const cost = pricing.calcCost('t1', 'skill-free', 'free', 0, 0, 0);
    expect(cost).toBe(0);
    expect(pricing.hasQuota('t1', 'skill-free', 0, 9999, 'free')).toBe(true);

    const comm = commission.calcCommission('t1', 'skill-free', 0, 'free', false, 'tool');
    expect(comm).toBeNull();
  });

  // ── K15-5: Freemium 超配额计费 ──

  it('freemium: within quota → free; over quota → overage charge', () => {
    const withinQuota = pricing.calcCost('t1', 'skill-premium', 'freemium', 5.0, 1000, 500);
    expect(withinQuota).toBe(0);
    expect(pricing.hasQuota('t1', 'skill-premium', 1000, 500, 'freemium')).toBe(true);

    const overQuota = pricing.calcCost('t1', 'skill-premium', 'freemium', 5.0, 1000, 1500);
    expect(overQuota).toBe(5.0);
    expect(pricing.hasQuota('t1', 'skill-premium', 1000, 1500, 'freemium')).toBe(false);
  });

  // ── K15-5: 抽佣率规则引擎端到端 ──

  it('commission: tenant-specific rule overrides default', () => {
    commission.addRule({
      ruleId: 'r-tenant',
      tenantId: 't1',
      tier: 'subscription',
      certified: false,
      commissionRate: 0.12,
      priority: 100,
      active: true,
      effectiveFrom: '2026-01-01T00:00:00Z',
    });
    commission.addRule({
      ruleId: 'r-default',
      tenantId: 't1',
      tier: '*',
      certified: false,
      commissionRate: 0.20,
      priority: 10,
      active: true,
      effectiveFrom: '2026-01-01T00:00:00Z',
    });

    const result = commission.calcCommission('t1', 'skill-a', 100, 'subscription', false, 'tool');
    expect(result).not.toBeNull();
    expect(result.commissionRate).toBe(0.12);
    expect(result.platformFee).toBe(12);
    expect(result.payout).toBe(88);
  });

  // ── K15-5: 结算对账端到端 ──

  it('reconciliation: detects critical cost discrepancy (20%)', () => {
    // meteringCalls=1 (matches splitRecords.length=1), totalCost=100
    // settlement cost=80 → diff=20, diffPct=0.2 ≥ 0.05 → critical
    const settlement: Settlement = {
      settlementId: 's-e2e',
      tenantId: 't1',
      period: '2026-01',
      totalRevenue: 100,
      totalSkillOwnerPayout: 80,
      totalPlatformRevenue: 20,
      splitRecords: [
        {
          recordId: 'sr-e2e',
          billId: 'bill-e2e',
          tenantId: 't1',
          skillId: 'skill-a',
          revenue: 100,
          splitRatio: 'standard',
          skillOwnerAmount: 80,
          platformAmount: 20,
          createdAt: '2026-02-01T00:00:00Z',
        },
      ],
      status: 'completed',
      createdAt: '2026-02-01T00:00:00Z',
    };

    const discrepancies = reconciliation.detectDiscrepancies('t1', '2026-01', 1, 100, [settlement]);
    const costDisc = discrepancies.find((d) => d.type === 'cost');
    expect(costDisc).toBeDefined();
    expect(costDisc.severity).toBe('critical');
    expect(costDisc.diffPct).toBe(0.2);
  });

  it('reconciliation: warning severity for 2% diff', () => {
    const settlement: Settlement = {
      settlementId: 's-e2e-warn',
      tenantId: 't1',
      period: '2026-01',
      totalRevenue: 100,
      totalSkillOwnerPayout: 98,
      totalPlatformRevenue: 2,
      splitRecords: [
        {
          recordId: 'sr-e2e-warn',
          billId: 'bill-e2e-warn',
          tenantId: 't1',
          skillId: 'skill-a',
          revenue: 100,
          splitRatio: 'standard',
          skillOwnerAmount: 98,
          platformAmount: 2,
          createdAt: '2026-02-01T00:00:00Z',
        },
      ],
      status: 'completed',
      createdAt: '2026-02-01T00:00:00Z',
    };

    const discrepancies = reconciliation.detectDiscrepancies('t1', '2026-01', 1, 100, [settlement]);
    const costDisc = discrepancies.find((d) => d.type === 'cost');
    expect(costDisc).toBeDefined();
    expect(costDisc.severity).toBe('warning');
    expect(costDisc.diffPct).toBe(0.02);
  });

  // ── K15-5: 多租户仪表板聚合 ──

  it('dashboard: getPlatformOverview aggregates multi-tenant data', () => {
    // 注入 mock 依赖
    const mockDelistWarning = {
      listWarnings: jest.fn().mockReturnValue([]),
      addWarning: jest.fn(),
    };
    const mockSkillRating = {
      recordRating: jest.fn(),
      listRatings: jest.fn().mockReturnValue({ ratings: [], total: 0 }),
      getAverageRating: jest.fn().mockReturnValue(4.5),
    };
    const mockCertification = {
      isCertified: jest.fn().mockReturnValue(false),
      listCertifications: jest.fn().mockReturnValue({ records: [] }),
    };
    const dashboardWithDeps = new MarketDashboardService(
      billing,
      settlement,
      mockSkillRating as unknown as import('../services/skill-rating.service').SkillRatingService,
      mockDelistWarning as unknown as import('../services/delist-warning.service').DelistWarningService,
      mockCertification as unknown as import('../services/certification-engine.service').CertificationEngineService,
      mockForecastService as any,
    );

    // 使用 MeteringCollectorService 记录调用（正确的异步路径）
    const collectorSvc = new MeteringCollectorService(billing, new PolicyPackExclusiveService());
    // 直接用 billing 记录 MeteringRecord
    billing.recordCall({
      recordId: 'r1',
      tenantId: 'tA',
      skillId: 'skill-1',
      callAt: new Date().toISOString(),
      durationMs: 100,
      cost: 5,
      usageType: 'tool',
      evidenceId: 'e1',
      traceSpanId: 's1',
    });
    billing.recordCall({
      recordId: 'r2',
      tenantId: 'tB',
      skillId: 'skill-2',
      callAt: new Date().toISOString(),
      durationMs: 80,
      cost: 3,
      usageType: 'tool',
      evidenceId: 'e2',
      traceSpanId: 's2',
    });
    billing.generateBill('tA', '2026-01');
    billing.generateBill('tB', '2026-01');

    const overview = dashboardWithDeps.getPlatformOverview('2026-01');
    expect(overview.totalTenants).toBeGreaterThanOrEqual(2);
    expect(typeof overview.totalRevenue).toBe('number');
  });

  it('full free-tier chain: zero cost flows through billing', () => {
    pricing.calcCost('t1', 'skill-zero', 'free', 0, 0, 0);

    // 直接使用 MeteringRecord 格式（而非 ToolCallResult）
    billing.recordCall({
      recordId: 'r-zero',
      tenantId: 't1',
      skillId: 'skill-zero',
      callAt: new Date().toISOString(),
      durationMs: 100,
      cost: 0,
      usageType: 'tool',
      evidenceId: 'ev-zero-' + Date.now(),
      traceSpanId: 'span-zero',
    });
    const records = billing.getAllMetering();
    expect(records.length).toBeGreaterThan(0);

    const bill = billing.generateBill('t1', '2026-01');
    expect(bill.totalCost).toBe(0);

    const comm = commission.calcCommission('t1', 'skill-zero', 0, 'free', false, 'tool');
    expect(comm).toBeNull();
  });

  // ── Helper ──

  function makeRecord(tenantId: string, skillId: string): ToolCallResult {
    return {
      runId: `run-${Date.now()}`,
      tenantId,
      skillId,
      toolName: 'test-tool',
      input: {},
      output: { result: 'ok' },
      durationMs: 100,
      cost: 0,
      model: 'test-model',
      usage: { promptTokens: 10, completionTokens: 5 },
      timestamp: new Date().toISOString(),
    } as unknown as ToolCallResult;
  }
});
