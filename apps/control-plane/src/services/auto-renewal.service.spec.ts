import { Test, TestingModule } from '@nestjs/testing';
import { AutoRenewalService, type AutoRenewalConfig, type ProcessedRenewalResult } from './auto-renewal.service';
import { CertifiedSkillPricingService, type PricingPeriod } from './certified-skill-pricing.service';

describe('AutoRenewalService (K20-1)', () => {
  let service: AutoRenewalService;
  let pricingService: CertifiedSkillPricingService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [AutoRenewalService, CertifiedSkillPricingService],
    }).compile();
    service = module.get<AutoRenewalService>(AutoRenewalService);
    pricingService = module.get<CertifiedSkillPricingService>(CertifiedSkillPricingService);
  });

  afterEach(() => {
    service.clear();
    pricingService.clear();
  });

  // ── scheduleRenewal ──

  describe('scheduleRenewal', () => {
    it('creates a scheduled renewal config', () => {
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      const config = service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', '2026-03-15T00:00:00Z', 7);

      expect(config.status).toBe('scheduled');
      expect(config.planId).toBe(plan.planId);
      expect(config.tenantId).toBe('tenant-1');
      expect(config.skillId).toBe('skill-a');
      expect(config.autoRenew).toBe(true);
      expect(config.gracePeriodDays).toBe(7);
    });

    it('updates existing scheduled renewal (idempotent)', () => {
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      const c1 = service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', '2026-03-15T00:00:00Z', 7);
      const c2 = service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', '2026-04-01T00:00:00Z', 14);

      expect(c2.configId).toBe(c1.configId);
      expect(c2.nextBillingDate).toBe('2026-04-01T00:00:00Z');
      expect(c2.gracePeriodDays).toBe(14);
    });

    it('allows different tenants for same planId', () => {
      const plan1 = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      const plan2 = pricingService.createPricingPlan('skill-a', 'tenant-2', 'monthly', 10.0);
      const c1 = service.scheduleRenewal(plan1.planId, 'tenant-1', 'skill-a', '2026-03-15T00:00:00Z');
      const c2 = service.scheduleRenewal(plan2.planId, 'tenant-2', 'skill-a', '2026-03-15T00:00:00Z');

      expect(c1.configId).not.toBe(c2.configId);
      expect(c1.tenantId).toBe('tenant-1');
      expect(c2.tenantId).toBe('tenant-2');
    });
  });

  // ── processRenewals ──

  describe('processRenewals', () => {
    it('renews active subscription successfully', () => {
      const now = new Date().toISOString();
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', now, 7);

      const results = service.processRenewals(now);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('renewed');
      expect(results[0].planUpdated).toBe(true);
    });

    it('skips non-scheduled renewals', () => {
      const now = new Date().toISOString();
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', now, 7);
      service.cancelRenewal(plan.planId, 'tenant-1');

      const results = service.processRenewals(now);
      expect(results).toHaveLength(0);
    });

    it('skips future renewals (not yet due)', () => {
      const future = new Date(Date.now() + 30 * 86400000).toISOString();
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', future, 7);

      const results = service.processRenewals(new Date().toISOString());
      expect(results).toHaveLength(0);
    });

    it('expires renewal after grace period', () => {
      const past = new Date(Date.now() - 30 * 86400000).toISOString();
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', past, 7);

      const results = service.processRenewals(new Date().toISOString());
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('grace_expired');
    });

    it('handles missing pricing plan gracefully', () => {
      const now = new Date().toISOString();
      service.scheduleRenewal('non-existent-plan', 'tenant-1', 'skill-a', now, 7);

      const results = service.processRenewals(now);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('no_pricing_plan');
    });

    it('returns empty array when no renewals due', () => {
      const results = service.processRenewals(new Date().toISOString());
      expect(results).toHaveLength(0);
    });
  });

  // ── getUpcomingRenewals ──

  describe('getUpcomingRenewals', () => {
    it('returns scheduled renewals due within hoursAhead window', () => {
      const now = new Date().toISOString();
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', now, 7);

      const upcoming = service.getUpcomingRenewals('tenant-1', 24);
      expect(upcoming).toHaveLength(1);
      expect(upcoming[0].status).toBe('scheduled');
    });

    it('filters by tenantId', () => {
      const now = new Date().toISOString();
      const plan1 = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      const plan2 = pricingService.createPricingPlan('skill-b', 'tenant-2', 'monthly', 10.0);
      service.scheduleRenewal(plan1.planId, 'tenant-1', 'skill-a', now, 7);
      service.scheduleRenewal(plan2.planId, 'tenant-2', 'skill-b', now, 7);

      const tenant1Renewals = service.getUpcomingRenewals('tenant-1', 24);
      expect(tenant1Renewals).toHaveLength(1);
      expect(tenant1Renewals[0].tenantId).toBe('tenant-1');
    });

    it('excludes cancelled renewals', () => {
      const now = new Date().toISOString();
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', now, 7);
      service.cancelRenewal(plan.planId, 'tenant-1');

      const upcoming = service.getUpcomingRenewals('tenant-1', 24);
      expect(upcoming).toHaveLength(0);
    });

    it('returns empty array when no renewals', () => {
      const upcoming = service.getUpcomingRenewals('tenant-1', 24);
      expect(upcoming).toHaveLength(0);
    });
  });

  // ── cancelRenewal ──

  describe('cancelRenewal', () => {
    it('cancels a scheduled renewal', () => {
      const now = new Date().toISOString();
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', now, 7);

      const result = service.cancelRenewal(plan.planId, 'tenant-1');
      expect(result).toBe(true);
    });

    it('returns false for non-existent renewal', () => {
      const result = service.cancelRenewal('non-existent', 'tenant-1');
      expect(result).toBe(false);
    });

    it('prevents cancelled renewal from being processed', () => {
      const now = new Date().toISOString();
      const plan = pricingService.createPricingPlan('skill-a', 'tenant-1', 'monthly', 10.0);
      service.scheduleRenewal(plan.planId, 'tenant-1', 'skill-a', now, 7);
      service.cancelRenewal(plan.planId, 'tenant-1');

      const results = service.processRenewals(now);
      expect(results).toHaveLength(0);
    });
  });

  // ── tenant isolation ──

  describe('tenant isolation', () => {
    it.each([
      ['tenant-a', 'tenant-b'],
      ['t1', 't2'],
    ])('keeps renewals separate for different tenants', (tid1, tid2) => {
      const plan1 = pricingService.createPricingPlan('skill-a', tid1, 'monthly', 10.0);
      const plan2 = pricingService.createPricingPlan('skill-a', tid2, 'monthly', 10.0);
      service.scheduleRenewal(plan1.planId, tid1, 'skill-a', '2026-03-15T00:00:00Z');
      service.scheduleRenewal(plan2.planId, tid2, 'skill-a', '2026-03-15T00:00:00Z');

      const r1 = service.getUpcomingRenewals(tid1);
      const r2 = service.getUpcomingRenewals(tid2);
      expect(r1).toHaveLength(1);
      expect(r2).toHaveLength(1);
      expect(r1[0].configId).not.toBe(r2[0].configId);
    });
  });
});
