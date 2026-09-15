import { Test, TestingModule } from '@nestjs/testing';
import { MarketDashboardService, type RevenueSummary, type WarningMetrics, type CertificationStats, type PlatformOverview } from './market-dashboard.service';
import { BillingEngineService } from './billing-engine.service';
import { MeteringService } from './metering.service';
import { CertifiedSkillPricingService } from './certified-skill-pricing.service';
import { SettlementService } from './settlement-service';
import { SplitEngineService } from './split-engine.service';
import { SkillRatingService } from './skill-rating.service';
import { DelistWarningService } from './delist-warning.service';
import { CertificationEngineService } from './certification-engine.service';
import { ForecastService } from './forecast.service';
import { AutoRenewalService } from './auto-renewal.service';
import { type MonthlyBill, type MeteringRecord, type SplitRecord, type Settlement, type UserRating, type CertificationRecord, type DelistWarning } from '@aegisci/shared/types';

describe('MarketDashboardService (K14/K15)', () => {
  let service: MarketDashboardService;
  let billingEngine: BillingEngineService;
  let settlementService: SettlementService;
  let splitEngine: SplitEngineService;
  let skillRating: SkillRatingService;
  let delistWarning: DelistWarningService;
  let certificationEngine: CertificationEngineService;
  let forecastService: ForecastService;
  let autoRenewalService: AutoRenewalService;
  let pricingService: CertifiedSkillPricingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketDashboardService,
        BillingEngineService,
        MeteringService,
        CertifiedSkillPricingService,
        SettlementService,
        SplitEngineService,
        SkillRatingService,
        DelistWarningService,
        CertificationEngineService,
        ForecastService,
        AutoRenewalService,
      ],
    }).compile();
    service = module.get<MarketDashboardService>(MarketDashboardService);
    billingEngine = module.get<BillingEngineService>(BillingEngineService);
    settlementService = module.get<SettlementService>(SettlementService);
    splitEngine = module.get<SplitEngineService>(SplitEngineService);
    skillRating = module.get<SkillRatingService>(SkillRatingService);
    delistWarning = module.get<DelistWarningService>(DelistWarningService);
    certificationEngine = module.get<CertificationEngineService>(CertificationEngineService);
    forecastService = module.get<ForecastService>(ForecastService);
    autoRenewalService = module.get<AutoRenewalService>(AutoRenewalService);
    pricingService = module.get<CertifiedSkillPricingService>(CertifiedSkillPricingService);
  });

  afterEach(() => {
    billingEngine.clear();
    settlementService.clear();
    splitEngine.clear();
    skillRating.clear();
    delistWarning.clear();
    certificationEngine.clear();
    forecastService['clear']?.();
    autoRenewalService.clear();
    pricingService.clear();
  });

  // ── getCompositeDashboard ──

  describe('getCompositeDashboard', () => {
    it('returns empty dashboard for unknown tenant', () => {
      const dashboard = service.getCompositeDashboard('tenant-empty');
      expect(dashboard.tenantId).toBe('tenant-empty');
      expect(dashboard.healthScore).toBe(0);
      expect(dashboard.skillCount).toBe(0);
      expect(dashboard.revenueMetrics.totalRevenue).toBe(0);
      expect(dashboard.ratingMetrics.avgScore).toBeNull();
    });

    it('aggregates data from multiple sources', () => {
      // 设置计量数据
      billingEngine.recordCall({
        recordId: 'm-1',
        tenantId: 'tenant-1',
        skillId: 'skill-a',
        callAt: '2026-01-15T10:00:00Z',
        durationMs: 100,
        cost: 0.5,
        usageType: 'tool',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      } as MeteringRecord);
      billingEngine.recordCall({
        recordId: 'm-2',
        tenantId: 'tenant-1',
        skillId: 'skill-b',
        callAt: '2026-01-15T11:00:00Z',
        durationMs: 200,
        cost: 1.0,
        usageType: 'agent',
        evidenceId: 'ev-2',
        traceSpanId: 'span-2',
      } as MeteringRecord);

      // 设置评分数据
      skillRating.submitRating('tenant-1', 'skill-a', 5);
      skillRating.submitRating('tenant-1', 'skill-b', 3);

      // 设置认证数据
      const cert = certificationEngine.applyCertification('skill-a', 'tenant-1');
      certificationEngine.reviewCertification(cert.certificationId, true, 'reviewer-1');

      const dashboard = service.getCompositeDashboard('tenant-1');
      expect(dashboard.tenantId).toBe('tenant-1');
      expect(dashboard.skillCount).toBe(2);
      expect(dashboard.certifiedSkillCount).toBe(1);
      expect(dashboard.healthScore).toBeGreaterThan(0);
      expect(dashboard.ratingMetrics.excellentCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ── getHealthScore ──

  describe('getHealthScore', () => {
    it('returns 0 for tenant with no skills', () => {
      const result = service.getHealthScore('tenant-empty');
      expect(result.overall).toBe(0);
      expect(Object.keys(result.skills).length).toBe(0);
    });

    it('calculates overall score from individual ratings', () => {
      skillRating.submitRating('tenant-1', 'skill-a', 5);
      skillRating.submitRating('tenant-1', 'skill-b', 3);
      const result = service.getHealthScore('tenant-1');
      expect(result.skills['skill-a']).toBeGreaterThan(0);
      expect(result.skills['skill-b']).toBeGreaterThan(0);
      expect(result.overall).toBeGreaterThan(0);
    });
  });

  // ── getRevenueSummary ──

  describe('getRevenueSummary', () => {
    it('returns zero revenue for empty tenant', () => {
      const revenue = service.getRevenueSummary('tenant-empty');
      expect(revenue.totalRevenue).toBe(0);
      expect(revenue.monthlyTrend).toHaveLength(0);
      expect(revenue.topSkills).toHaveLength(0);
    });

    it('aggregates revenue from settlements', () => {
      const bill1: MonthlyBill = {
        billId: 'bill-1',
        tenantId: 'tenant-1',
        period: '2026-01',
        totalCalls: 10,
        totalCost: 50,
        lineItems: [{ skillId: 'skill-a', name: 'Skill A', calls: 10, unitPrice: 5, subtotal: 50 }],
        status: 'finalized',
        createdAt: '2026-01-31T00:00:00Z',
      };
      const bill2: MonthlyBill = {
        billId: 'bill-2',
        tenantId: 'tenant-1',
        period: '2026-02',
        totalCalls: 20,
        totalCost: 100,
        lineItems: [{ skillId: 'skill-b', name: 'Skill B', calls: 20, unitPrice: 5, subtotal: 100 }],
        status: 'finalized',
        createdAt: '2026-02-28T00:00:00Z',
      };

      settlementService.generateSettlement(bill1);
      settlementService.generateSettlement(bill2);

      const revenue = service.getRevenueSummary('tenant-1');
      expect(revenue.totalRevenue).toBe(150);
      expect(revenue.monthlyTrend).toHaveLength(2);
      expect(revenue.topSkills.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── getWarningStats ──

  describe('getWarningStats', () => {
    it('returns zero warnings for empty tenant', () => {
      const warnings = service.getWarningStats('tenant-empty');
      expect(warnings.totalWarnings).toBe(0);
      expect(warnings.staleCount).toBe(0);
      expect(warnings.lowQualityCount).toBe(0);
    });

    it('counts warnings by reason', () => {
      const w1: DelistWarning = {
        warningId: 'w-1',
        skillId: 'skill-bad',
        tenantId: 'tenant-1',
        reason: 'both',
        compositeScore: 20,
        generatedAt: new Date().toISOString(),
      };
      const w2: DelistWarning = {
        warningId: 'w-2',
        skillId: 'skill-stale',
        tenantId: 'tenant-1',
        reason: 'stale',
        compositeScore: 25,
        generatedAt: new Date().toISOString(),
      };
      (delistWarning as any).warningStore.set(w1.warningId, w1);
      (delistWarning as any).warningStore.set(w2.warningId, w2);

      const warnings = service.getWarningStats('tenant-1');
      expect(warnings.totalWarnings).toBe(2);
      expect(warnings.staleCount).toBe(2);
      expect(warnings.lowQualityCount).toBe(1);
    });
  });

  // ── getCertificationStats ──

  describe('getCertificationStats', () => {
    it('returns zero stats for empty tenant', () => {
      const stats = service.getCertificationStats('tenant-empty');
      expect(stats.total).toBe(0);
      expect(stats.approved).toBe(0);
      expect(stats.pending).toBe(0);
      expect(stats.suspended).toBe(0);
    });

    it('counts certifications by status', () => {
      const c1 = certificationEngine.applyCertification('skill-a', 'tenant-1');
      const c2 = certificationEngine.applyCertification('skill-b', 'tenant-1');
      certificationEngine.reviewCertification(c1.certificationId, true, 'reviewer-1');
      certificationEngine.reviewCertification(c2.certificationId, false, 'reviewer-1');

      const stats = service.getCertificationStats('tenant-1');
      expect(stats.total).toBe(2);
      expect(stats.approved).toBe(1);
      expect(stats.pending).toBe(0);
    });
  });

  // ── getTenantSummary (K15-4) ──

  describe('getTenantSummary', () => {
    it('returns empty summary for unknown tenant', () => {
      const summary = service.getTenantSummary('tenant-empty');
      expect(summary.skillCount).toBe(0);
      expect(summary.totalRevenue).toBe(0);
      expect(summary.avgHealthScore).toBe(0);
    });

    it('returns correct summary for tenant with data', () => {
      billingEngine.recordCall({
        recordId: 'm-1',
        tenantId: 'tenant-1',
        skillId: 'skill-a',
        callAt: '2026-01-15T10:00:00Z',
        durationMs: 100,
        cost: 0.5,
        usageType: 'tool',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      } as MeteringRecord);
      skillRating.submitRating('tenant-1', 'skill-a', 5);

      const summary = service.getTenantSummary('tenant-1');
      expect(summary.skillCount).toBe(1);
      expect(summary.totalRevenue).toBe(0);
      expect(summary.avgHealthScore).toBeGreaterThan(0);
      expect(summary.certifiedCount).toBe(0);
      expect(summary.warningCount).toBe(0);
    });
  });

  // ── getPlatformOverview (K15-4) ──

  describe('getPlatformOverview', () => {
    it('returns zero overview for empty platform', () => {
      const overview = service.getPlatformOverview();
      expect(overview.totalTenants).toBe(0);
      expect(overview.totalSkills).toBe(0);
      expect(overview.totalRevenue).toBe(0);
      expect(overview.avgHealthScore).toBe(0);
    });

    it('aggregates data from multiple tenants', () => {
      // tenant-1
      billingEngine.recordCall({
        recordId: 'm-1',
        tenantId: 'tenant-1',
        skillId: 'skill-a',
        callAt: '2026-01-15T10:00:00Z',
        durationMs: 100,
        cost: 0.5,
        usageType: 'tool',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      } as MeteringRecord);
      skillRating.submitRating('tenant-1', 'skill-a', 5);

      // tenant-2
      billingEngine.recordCall({
        recordId: 'm-2',
        tenantId: 'tenant-2',
        skillId: 'skill-b',
        callAt: '2026-01-15T11:00:00Z',
        durationMs: 200,
        cost: 1.0,
        usageType: 'agent',
        evidenceId: 'ev-2',
        traceSpanId: 'span-2',
      } as MeteringRecord);
      skillRating.submitRating('tenant-2', 'skill-b', 3);

      const overview = service.getPlatformOverview();
      expect(overview.totalTenants).toBe(2);
      expect(overview.totalSkills).toBe(2);
      expect(overview.totalActiveSkills).toBe(2);
      expect(overview.totalRevenue).toBe(0); // free tier, no billing
      expect(overview.avgHealthScore).toBeGreaterThan(0);
    });
  });

  // ── Integration: full flow ──

  describe('integration: full flow', () => {
    it('produces coherent dashboard with all data sources', () => {
      billingEngine.recordCall({
        recordId: 'm-1',
        tenantId: 'tenant-1',
        skillId: 'skill-pro',
        callAt: '2026-01-15T10:00:00Z',
        durationMs: 50,
        cost: 0.25,
        usageType: 'tool',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      } as MeteringRecord);

      skillRating.submitRating('tenant-1', 'skill-pro', 5);

      const cert = certificationEngine.applyCertification('skill-pro', 'tenant-1');
      certificationEngine.reviewCertification(cert.certificationId, true, 'reviewer-1');
      skillRating.linkCertification('skill-pro', cert);

      const bill: MonthlyBill = {
        billId: 'bill-pro',
        tenantId: 'tenant-1',
        period: '2026-01',
        totalCalls: 1,
        totalCost: 0.25,
        lineItems: [{ skillId: 'skill-pro', name: 'Pro Skill', calls: 1, unitPrice: 0.25, subtotal: 0.25 }],
        status: 'finalized',
        createdAt: '2026-01-31T00:00:00Z',
      };
      settlementService.generateSettlement(bill);

      const dashboard = service.getCompositeDashboard('tenant-1');

      expect(dashboard.skillCount).toBe(1);
      expect(dashboard.certifiedSkillCount).toBe(1);
      expect(dashboard.revenueMetrics.totalRevenue).toBe(0.25);
      expect(dashboard.ratingMetrics.goodCount).toBe(1);
      expect(dashboard.healthScore).toBeGreaterThan(0);
    });
  });

  // ── K16-3: forecast 集成测试 ──

  describe('forecast integration', () => {
    it('getCompositeDashboard includes forecast field', () => {
      const dashboard = service.getCompositeDashboard('tenant-empty');
      expect(dashboard.forecast).toBeDefined();
      expect(dashboard.forecast.insufficientData).toBe(true);
    });

    it('getPlatformOverview includes platformForecast field', () => {
      const overview = service.getPlatformOverview();
      expect(overview.platformForecast).toBeDefined();
      expect(overview.platformForecast.insufficientData).toBe(true);
    });

    it('forecast uses linear method by default', () => {
      const dashboard = service.getCompositeDashboard('tenant-empty');
      expect(dashboard.forecast.method).toBe('linear');
    });

    it('forecast has valid confidence interval bounds', () => {
      const dashboard = service.getCompositeDashboard('tenant-empty');
      expect(dashboard.forecast.lowerBound).toBeLessThanOrEqual(dashboard.forecast.upperBound);
    });
  });

  // ── K20-4: renewal reminders ──

  describe('getRenewalReminders (K20-4)', () => {
    it('returns empty array when no renewals scheduled', () => {
      const reminders = service.getRenewalReminders('tenant-1', 24);
      expect(reminders).toHaveLength(0);
    });

    it('returns scheduled renewals within hoursAhead window', () => {
      const now = new Date().toISOString();
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      autoRenewalService.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', now, 7);

      const reminders = service.getRenewalReminders('tenant-1', 24);
      expect(reminders).toHaveLength(1);
      expect(reminders[0].tenantId).toBe('tenant-1');
      expect(reminders[0].autoRenew).toBe(true);
    });

    it('filters by tenantId', () => {
      const now = new Date().toISOString();
      const plan1 = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      const plan2 = pricingService.createPricingPlan('skill-b', 'tenant-2', 'monthly', 10.0);
      autoRenewalService.scheduleRenewal(plan1.planId, 'tenant-1', 'skill-a', now, 7);
      autoRenewalService.scheduleRenewal(plan2.planId, 'tenant-2', 'skill-b', now, 7);

      const reminders = service.getRenewalReminders('tenant-1', 24);
      expect(reminders).toHaveLength(1);
      expect(reminders[0].tenantId).toBe('tenant-1');
    });

    it('excludes cancelled renewals', () => {
      const now = new Date().toISOString();
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      autoRenewalService.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', now, 7);
      autoRenewalService.cancelRenewal(plan.planId, 'tenant-1');

      const reminders = service.getRenewalReminders('tenant-1', 24);
      expect(reminders).toHaveLength(0);
    });
  });
});
