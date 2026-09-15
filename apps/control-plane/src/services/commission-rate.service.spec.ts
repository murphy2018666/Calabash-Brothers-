import { CommissionRateService, type CommissionCalcResult } from './commission-rate.service';

describe('CommissionRateService (K15-2)', () => {
  let service: CommissionRateService;

  beforeEach(() => {
    service = new CommissionRateService();
  });

  afterEach(() => {
    service.clear();
  });

  describe('calcCommissionRate', () => {
    it('returns default standard rate when no rules configured', () => {
      const rate = service.calcCommissionRate('t1', 'skill-a', 'freemium', false, 'tool');
      expect(rate).toBe(0.20);
    });

    it('returns default certified rate for certified skills', () => {
      const rate = service.calcCommissionRate('t1', 'skill-a', 'freemium', true, 'tool');
      expect(rate).toBe(0.10);
    });

    it('applies tenant-specific rule', () => {
      service.addRule({
        ruleId: 'r1',
        tenantId: 't1',
        tier: 'subscription',
        certified: false,
        commissionRate: 0.15,
        priority: 10,
        active: true,
        effectiveFrom: '2026-01-01T00:00:00Z',
      });
      const rate = service.calcCommissionRate('t1', 'skill-a', 'subscription', false, 'tool');
      expect(rate).toBe(0.15);
    });

    it('applies skill-type-specific rule with higher priority', () => {
      service.addRule({
        ruleId: 'r1',
        tenantId: 't1',
        tier: '*',
        certified: false,
        skillType: 'agent',
        commissionRate: 0.08,
        priority: 10,
        active: true,
        effectiveFrom: '2026-01-01T00:00:00Z',
      });
      const rate = service.calcCommissionRate('t1', 'skill-a', 'freemium', false, 'agent');
      expect(rate).toBe(0.08);
    });

    it('selects highest priority matching rule', () => {
      service.addRule({
        ruleId: 'r1',
        tenantId: 't1',
        tier: 'freemium',
        certified: false,
        commissionRate: 0.25,
        priority: 5,
        active: true,
        effectiveFrom: '2026-01-01T00:00:00Z',
      });
      service.addRule({
        ruleId: 'r2',
        tenantId: 't1',
        tier: 'freemium',
        certified: false,
        commissionRate: 0.18,
        priority: 10,
        active: true,
        effectiveFrom: '2026-01-01T00:00:00Z',
      });
      const rate = service.calcCommissionRate('t1', 'skill-a', 'freemium', false, 'tool');
      expect(rate).toBe(0.18); // higher priority wins
    });

    it('ignores inactive rules', () => {
      service.addRule({
        ruleId: 'r1',
        tenantId: 't1',
        tier: 'freemium',
        certified: false,
        commissionRate: 0.05,
        priority: 10,
        active: false,
        effectiveFrom: '2026-01-01T00:00:00Z',
      });
      const rate = service.calcCommissionRate('t1', 'skill-a', 'freemium', false, 'tool');
      expect(rate).toBe(0.20); // falls back to default
    });
  });

  describe('calcCommission', () => {
    it('calculates correct commission amount', () => {
      const result: CommissionCalcResult = service.calcCommission('t1', 'skill-a', 100, 'freemium', false, 'tool');
      expect(result.commissionRate).toBe(0.20);
      expect(result.platformFee).toBe(20);
      expect(result.payout).toBe(80);
    });

    it('applies certified discount', () => {
      const result = service.calcCommission('t1', 'skill-a', 100, 'freemium', true, 'tool');
      expect(result.commissionRate).toBe(0.10);
      expect(result.platformFee).toBe(10);
      expect(result.payout).toBe(90);
    });

    it('returns null for free tier', () => {
      const result = service.calcCommission('t1', 'skill-a', 100, 'free', false, 'tool');
      expect(result).toBeNull();
    });
  });

  describe('addRule / removeRule', () => {
    it('addRule stores and retrieveable via getRules', () => {
      const rule = {
        ruleId: 'r1',
        tenantId: 't1',
        tier: 'subscription',
        certified: false,
        commissionRate: 0.15,
        priority: 10,
        active: true,
        effectiveFrom: '2026-01-01T00:00:00Z',
      };
      service.addRule(rule);
      const rules = service.getRules('t1');
      expect(rules).toHaveLength(1);
      expect(rules[0].ruleId).toBe('r1');
    });

    it('removeRule removes the rule', () => {
      service.addRule({
        ruleId: 'r1',
        tenantId: 't1',
        tier: 'subscription',
        certified: false,
        commissionRate: 0.15,
        priority: 10,
        active: true,
        effectiveFrom: '2026-01-01T00:00:00Z',
      });
      service.removeRule('t1', 'r1');
      const rules = service.getRules('t1');
      expect(rules).toHaveLength(0);
    });
  });

  describe('clear', () => {
    it('clears all rules', () => {
      service.addRule({
        ruleId: 'r1',
        tenantId: 't1',
        tier: 'subscription',
        certified: false,
        commissionRate: 0.15,
        priority: 10,
        active: true,
        effectiveFrom: '2026-01-01T00:00:00Z',
      });
      service.clear();
      expect(service.getRules('t1')).toHaveLength(0);
    });
  });
});
