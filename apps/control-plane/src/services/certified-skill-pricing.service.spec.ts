/**
 * CertifiedSkillPricingService 单元测试（K18-1）。
 * TDD 策略：先定义测试契约，再实现服务。
 * 使用参数化测试减少重复。
 */

import { CertifiedSkillPricingService } from './certified-skill-pricing.service';

describe('CertifiedSkillPricingService (K18-1)', () => {
  let service: CertifiedSkillPricingService;

  beforeEach(() => {
    service = new CertifiedSkillPricingService();
  });

  afterEach(() => {
    service.clear();
  });

  // ── 创建：三种计费周期参数化 ──

  it.each([
    ['monthly', 'skill-m', 't-1', 99.99],
    ['yearly', 'skill-y', 't-1', 999.99],
    ['perpetual', 'skill-p', 't-1', 499.99],
  ])('createPricingPlan: creates %s plan', (_period, skillId, tenantId, price) => {
    const plan = service.createPricingPlan(skillId, tenantId, _period as any, price);
    expect(plan).toBeDefined();
    expect(plan.skillId).toBe(skillId);
    expect(plan.tenantId).toBe(tenantId);
    expect(plan.period).toBe(_period);
    expect(plan.price).toBe(price);
    expect(plan.status).toBe('active');
  });

  it('createPricingPlan: generates unique IDs', () => {
    const p1 = service.createPricingPlan('skill-x', 't-x', 'monthly', 10);
    const p2 = service.createPricingPlan('skill-y', 't-y', 'yearly', 20);
    expect(p1.planId).not.toBe(p2.planId);
  });

  // ── 查询：正常、缺失、租户隔离参数化 ──

  it('getPricingPlan: returns plan by skillId+tenantId', () => {
    service.createPricingPlan('skill-q', 't-q', 'monthly', 49.99);
    const plan = service.getPricingPlan('skill-q', 't-q');
    expect(plan).toBeDefined();
    expect(plan!.price).toBe(49.99);
  });

  it('getPricingPlan: returns undefined for non-existent skill', () => {
    expect(service.getPricingPlan('skill-missing', 't-1')).toBeUndefined();
  });

  it.each([
    ['t-a', 10],
    ['t-b', 20],
  ])('getPricingPlan: tenant isolation - tenant %s gets price %d', (tenantId, expectedPrice) => {
    service.createPricingPlan('skill-same', 't-a', 'monthly', 10);
    service.createPricingPlan('skill-same', 't-b', 'monthly', 20);
    expect(service.getPricingPlan('skill-same', tenantId)!.price).toBe(expectedPrice);
  });

  // ── 更新：不同字段、不存在场景 ──

  it.each([
    [{ field: 'price' as const, value: 75, expectVal: 75 }],
    [{ field: 'period' as const, value: 'yearly' as const, expectVal: 'yearly' }],
  ])('updatePricingPlan: updates %s', ({ field, value, expectVal }) => {
    const plan = service.createPricingPlan('skill-u', 't-u', 'monthly', 50);
    const updated = service.updatePricingPlan(plan.planId, { [field]: value });
    expect(updated![field]).toBe(expectVal);
  });

  it('updatePricingPlan: returns null for non-existent plan', () => {
    expect(service.updatePricingPlan('fake-id', { price: 10 })).toBeNull();
  });

  // ── 删除：正常、不存在、租户隔离 ──

  it('deletePricingPlan: removes plan and returns true', () => {
    const plan = service.createPricingPlan('skill-d', 't-d', 'monthly', 99);
    expect(service.deletePricingPlan(plan.planId, 't-d')).toBe(true);
    expect(service.getPricingPlan('skill-d', 't-d')).toBeUndefined();
  });

  it('deletePricingPlan: returns false for non-existent plan', () => {
    expect(service.deletePricingPlan('fake-id', 't-d')).toBe(false);
  });

  it('deletePricingPlan: tenant isolation on delete', () => {
    const planA = service.createPricingPlan('skill-del', 't-a', 'monthly', 10);
    const planB = service.createPricingPlan('skill-del', 't-b', 'monthly', 20);
    service.deletePricingPlan(planA.planId, 't-a');
    expect(service.getPricingPlan('skill-del', 't-a')).toBeUndefined();
    expect(service.getPricingPlan('skill-del', 't-b')).toBeDefined();
    expect(service.getPricingPlan('skill-del', 't-b')!.planId).toBe(planB.planId);
  });

  // ── 校验规则：参数化合并 ──

  it.each([
    [0, 'monthly'],
    [-10, 'monthly'],
    [0, 'yearly'],
  ])('createPricingPlan: rejects price=%p', (price) => {
    expect(() => service.createPricingPlan('skill-x', 't-x', 'monthly', price)).toThrow();
  });

  it('createPricingPlan: rejects invalid period', () => {
    expect(() => service.createPricingPlan('skill-x', 't-x', 'invalid' as any, 100)).toThrow();
  });

  it('createPricingPlan: rejects duplicate for same skill+tenant', () => {
    service.createPricingPlan('skill-dup', 't-dup', 'monthly', 50);
    expect(() => service.createPricingPlan('skill-dup', 't-dup', 'monthly', 60)).toThrow();
  });

  // ── 列表查询：参数化 ──

  it('listPricingPlans: returns all plans for tenant', () => {
    service.createPricingPlan('skill-la', 't-list', 'monthly', 10);
    service.createPricingPlan('skill-lb', 't-list', 'yearly', 100);
    expect(service.listPricingPlans('t-list')).toHaveLength(2);
  });

  it.each([
    ['t-list-a', 1],
    ['t-list-b', 1],
  ])('listPricingPlans: tenant isolation - tenant %s has %d plan(s)', (tenantId, expected) => {
    service.createPricingPlan('skill-a', 't-list-a', 'monthly', 10);
    service.createPricingPlan('skill-a', 't-list-b', 'monthly', 20);
    expect(service.listPricingPlans(tenantId)).toHaveLength(expected);
  });
});
