/**
 * 测试模板库使用示例
 *
 * 演示如何使用 test-utils 中的模板和工具函数
 */

import { TestTemplates, TestHelpers, TEST_DATA, testTenant, testSkill } from '../test-utils';
import { CertifiedSkillPricingService } from '../services/certified-skill-pricing.service';

describe('Test Templates Usage Examples', () => {
  // ── 示例 1：使用 fixtures ──

  it('example: 使用 TEST_DATA 创建测试数据', () => {
    const { tenantId, skillId } = {
      tenantId: TEST_DATA.tenants.small,
      skillId: TEST_DATA.skills.tool,
    };

    expect(tenantId).toMatch(/^t-/);
    expect(skillId).toMatch(/^skill-/);
  });

  // ── 示例 2：使用 TestHelpers ──

  it('example: 使用 generateId 生成唯一 ID', () => {
    const id1 = TestHelpers.generateId('test');
    const id2 = TestHelpers.generateId('test');

    expect(id1).not.toBe(id2);
    expect(id1).toMatch(/^test-/);
  });

  it('example: 使用 createMockEventEmitter', () => {
    const mockEmitter = TestHelpers.createMockEventEmitter();

    mockEmitter.emit('test.event', { data: 'value' });
    mockEmitter.emit('test.event', { data: 'value2' });

    expect(mockEmitter.getEmitted()).toHaveLength(2);
    expect(mockEmitter.getEmitted()[0].event).toBe('test.event');
  });

  // ── 示例 3：使用自定义匹配器 ──

  it('example: toHaveProperties', () => {
    const obj = { name: 'test', age: 25, email: 'test@example.com' };

    expect(obj).toHaveProperties('name', 'age');
    expect(obj).not.toHaveProperties('missing');
  });

  it('example: toBeValidISODate', () => {
    expect('2026-09-13T10:00:00.000Z').toBeValidISODate();
    expect('invalid').not.toBeValidISODate();
  });

  it('example: toMatchStructure', () => {
    const plan = {
      planId: 'plan-123',
      skillId: 'skill-1',
      tenantId: 't-1',
      price: 99.99,
    };

    expect(plan).toMatchStructure({
      planId: expect.any(String),
      skillId: expect.any(String),
      price: expect.any(Number),
    });
  });

  // ── 示例 4：服务测试完整示例 ──

  it('example: 完整服务测试结构', () => {
    const service = new CertifiedSkillPricingService();

    // 创建
    const plan = service.createPricingPlan(
      TEST_DATA.skills.tool,
      TEST_DATA.tenants.small,
      'monthly',
      99.99,
    );
    expect(plan).toBeDefined();
    expect(plan.status).toBe('active');

    // 查询
    const found = service.getPricingPlan(plan.skillId, plan.tenantId);
    expect(found).toBeDefined();
    expect(found!.price).toBe(99.99);

    // 更新
    const updated = service.updatePricingPlan(plan.planId, { price: 149.99 });
    expect(updated!.price).toBe(149.99);

    // 删除
    const deleted = service.deletePricingPlan(plan.planId, plan.tenantId);
    expect(deleted).toBe(true);
    expect(service.getPricingPlan(plan.skillId, plan.tenantId)).toBeUndefined();

    // 清理
    service.clear();
  });

  // ── 示例 5：边界用例测试 ──

  it('example: 价格校验边界', () => {
    const service = new CertifiedSkillPricingService();

    // 负数价格
    expect(() =>
      service.createPricingPlan('skill-1', 't-1', 'monthly', -10),
    ).toThrow();

    // 零价格
    expect(() =>
      service.createPricingPlan('skill-1', 't-1', 'monthly', 0),
    ).toThrow();

    // 有效价格
    expect(() =>
      service.createPricingPlan('skill-1', 't-1', 'monthly', 0.01),
    ).not.toThrow();

    service.clear();
  });

  // ── 示例 6：租户隔离测试 ──

  it('example: 租户隔离验证', () => {
    const service = new CertifiedSkillPricingService();

    service.createPricingPlan('skill-same', testTenant('a'), 'monthly', 10);
    service.createPricingPlan('skill-same', testTenant('b'), 'monthly', 20);

    const plansA = service.listPricingPlans(testTenant('a'));
    const plansB = service.listPricingPlans(testTenant('b'));

    expect(plansA).toHaveLength(1);
    expect(plansB).toHaveLength(1);
    expect(plansA[0].price).toBe(10);
    expect(plansB[0].price).toBe(20);

    service.clear();
  });
});
