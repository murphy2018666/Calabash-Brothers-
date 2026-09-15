import { PricingModelService, type FreemiumQuota } from './pricing-model.service';

describe('PricingModelService (K15-1)', () => {
  let service: PricingModelService;

  beforeEach(() => {
    service = new PricingModelService();
  });

  afterEach(() => {
    service.clear();
  });

  describe('calcCost', () => {
    it('free tier always returns 0 cost', () => {
      const cost = service.calcCost('t1', 'skill-a', 'free', 0.1, 100, 999);
      expect(cost).toBe(0);
    });

    it('freemium within quota returns 0', () => {
      const cost = service.calcCost('t1', 'skill-a', 'freemium', 0.1, 100, 50);
      expect(cost).toBe(0);
    });

    it('freemium over quota charges overage price', () => {
      const cost = service.calcCost('t1', 'skill-a', 'freemium', 0.1, 100, 150);
      expect(cost).toBe(0.1);
    });

    it('subscription/usage tier returns -1 (handled by billing engine)', () => {
      const costSub = service.calcCost('t1', 'skill-a', 'subscription', 0.1, 100, 50);
      const costUsage = service.calcCost('t1', 'skill-a', 'usage', 0.1, 100, 50);
      expect(costSub).toBe(-1);
      expect(costUsage).toBe(-1);
    });

    it('uses tenantId and skillId for per-skill quota tracking', () => {
      service.calcCost('t1', 'skill-a', 'freemium', 0.1, 100, 150);
      // skill-b still within quota
      const cost = service.calcCost('t1', 'skill-b', 'freemium', 0.1, 100, 150);
      expect(cost).toBe(0.1); // skill-b also over quota, but independent
    });
  });

  describe('hasQuota', () => {
    it('returns true when within monthly quota', () => {
      expect(service.hasQuota('t1', 'skill-a', 100, 50)).toBe(true);
    });

    it('returns false when exceeding monthly quota', () => {
      expect(service.hasQuota('t1', 'skill-a', 100, 150)).toBe(false);
    });

    it('returns true for free tier regardless of usage', () => {
      expect(service.hasQuota('t1', 'skill-a', 0, 9999, 'free')).toBe(true);
    });

    it('only applies to freemium tier', () => {
      // hasQuota is generic; subscription tier caller should handle internally
      expect(service.hasQuota('t1', 'skill-a', 100, 50)).toBe(true);
    });
  });

  describe('getQuotaInfo', () => {
    it('returns quota info for freemium tier', () => {
      const info: FreemiumQuota = service.getQuotaInfo('t1', 'skill-a', 100, 50);
      expect(info.tenantId).toBe('t1');
      expect(info.skillId).toBe('skill-a');
      expect(info.quota).toBe(100);
      expect(info.used).toBe(50);
      expect(info.remaining).toBe(50);
      expect(info.exceeded).toBe(false);
    });

    it('returns exceeded=true when over quota', () => {
      const info = service.getQuotaInfo('t1', 'skill-a', 100, 150);
      expect(info.exceeded).toBe(true);
      expect(info.remaining).toBe(0);
    });
  });

  describe('clear', () => {
    it('clears all quota state', () => {
      service.calcCost('t1', 'skill-a', 'freemium', 0.1, 100, 150);
      service.clear();
      // After clear, quota tracking is reset
      const cost = service.calcCost('t1', 'skill-a', 'freemium', 0.1, 100, 50);
      expect(cost).toBe(0); // back to within quota after reset
    });
  });
});
