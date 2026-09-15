/**
 * E2E 测试示例（展示如何使用模板库）
 */

import { TestHelpers, TEST_DATA } from '../test-utils';
import { CertifiedSkillPricingService } from '../services/certified-skill-pricing.service';
import { PolicyPackExclusiveService } from '../services/policy-pack-exclusive.service';
import { MeteringService } from '../services/metering.service';

describe('E2E Template Usage Examples (S28)', () => {
  let pricing: CertifiedSkillPricingService;
  let exclusivePack: PolicyPackExclusiveService;
  let metering: MeteringService;

  beforeEach(() => {
    pricing = new CertifiedSkillPricingService();
    exclusivePack = new PolicyPackExclusiveService();
    metering = new MeteringService();
  });

  afterEach(() => {
    pricing.clear();
    exclusivePack.clear();
    metering.clear();
  });

  // ── 场景 1：完整业务流程 ──

  it('E2E-1: 付费技能调用流程', () => {
    // 1. 创建定价计划
    const plan = pricing.createPricingPlan(
      TEST_DATA.skills.tool,
      TEST_DATA.tenants.small,
      'monthly',
      99.99,
    );
    expect(plan.status).toBe('active');

    // 2. 记录计量
    const event = metering.recordUsage('call', TEST_DATA.tenants.small, TEST_DATA.skills.tool, {
      cost: 10,
    });
    expect(event.eventId).toBeTruthy();

    // 3. 查询统计
    const stats = metering.getStats(TEST_DATA.tenants.small);
    expect(stats.totalCalls).toBe(1);
    expect(stats.totalCost).toBe(10);
  });

  // ── 场景 2：独占包授权流程 ──

  it('E2E-2: 独占包授权与访问控制', () => {
    // 1. 创建并发布独占包
    const pack = exclusivePack.createExclusivePack(
      TEST_DATA.tenants.small,
      'exclusive-pack-1',
      ['pol-1'],
    );
    exclusivePack.publishPack(pack.packId);

    // 2. 授权另一个租户
    exclusivePack.grantAccess(pack.packId, TEST_DATA.tenants.medium);

    // 3. 验证授权租户可访问
    const packs = exclusivePack.getAvailablePacks(TEST_DATA.tenants.medium);
    expect(packs.some((p) => p.packId === pack.packId)).toBe(true);

    // 4. 验证未授权租户不可访问
    const deniedPacks = exclusivePack.getAvailablePacks(TEST_DATA.tenants.large);
    expect(deniedPacks.length).toBe(0);
  });

  // ── 场景 3：批量计量写入 ──

  it('E2E-3: 批量计量写入与一致性验证', () => {
    const events = [
      { eventType: 'call', tenantId: TEST_DATA.tenants.small, skillId: TEST_DATA.skills.tool, metadata: { cost: 10 } },
      { eventType: 'call', tenantId: TEST_DATA.tenants.small, skillId: TEST_DATA.skills.agent, metadata: { cost: 20 } },
      { eventType: 'agent', tenantId: TEST_DATA.tenants.small, skillId: TEST_DATA.skills.tool, metadata: { cost: 30 } },
    ];

    metering.batchRecord(events);

    const records = metering.queryUsage(TEST_DATA.tenants.small);
    const stats = metering.getStats(TEST_DATA.tenants.small);

    expect(records.length).toBe(3);
    expect(stats.totalCalls).toBe(3);
    expect(stats.totalCost).toBe(60);
    expect(stats.bySkill[TEST_DATA.skills.tool].calls).toBe(2);
  });

  // ── 场景 4：性能基准测试 ──

  it('E2E-4: 计量写入性能 < 10ms P95', () => {
    const iterations = 100;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      metering.recordUsage('call', TEST_DATA.tenants.small, TEST_DATA.skills.tool, {});
      times.push(Date.now() - start);
    }

    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(iterations * 0.95)];

    expect(p95).toBeLessThan(10);
  });

  // ── 场景 5：并发安全测试 ──

  it('E2E-5: 并发 50 QPS 不丢数据', async () => {
    const concurrency = 50;
    const promises = Array.from({ length: concurrency }, (_, i) =>
      metering.recordUsage('call', TEST_DATA.tenants.small, `skill-c${i}`, {}),
    );

    await Promise.all(promises);

    const records = metering.queryUsage(TEST_DATA.tenants.small);
    expect(records.length).toBe(concurrency);
  });

  // ── 场景 6：跨服务集成测试 ──

  it('E2E-6: 定价 + 计量 + 独占包 联动', () => {
    // 1. 创建独占包并发布并授权
    const pack = exclusivePack.createExclusivePack(TEST_DATA.tenants.small, 'linked-pack', ['pol-1']);
    exclusivePack.publishPack(pack.packId);
    exclusivePack.grantAccess(pack.packId, TEST_DATA.tenants.medium);

    // 2. 为授权租户创建定价
    pricing.createPricingPlan(TEST_DATA.skills.tool, TEST_DATA.tenants.medium, 'monthly', 49.99);

    // 3. 记录计量
    metering.recordUsage('call', TEST_DATA.tenants.medium, TEST_DATA.skills.tool, { cost: 5 });

    // 4. 验证所有服务数据一致
    const packs = exclusivePack.getAvailablePacks(TEST_DATA.tenants.medium);
    const stats = metering.getStats(TEST_DATA.tenants.medium);
    const plan = pricing.getPricingPlan(TEST_DATA.skills.tool, TEST_DATA.tenants.medium);

    expect(packs.length).toBeGreaterThan(0);
    expect(stats.totalCalls).toBe(1);
    expect(plan).toBeDefined();
  });
});
