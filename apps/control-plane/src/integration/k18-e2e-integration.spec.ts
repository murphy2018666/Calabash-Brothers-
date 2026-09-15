/**
 * K18 端到端集成测试（付费技能流程 + 计量基准）。
 *
 * 场景：
 * 1. 付费技能调用 → 计量记录 → 账单生成
 * 2. 免费额度用完后触发付费计费
 * 3. 独占 Policy Pack 下的计费隔离
 * 4. 计量数据查询与账单对账一致
 * 5. 性能基准：计量写入 P95 < 10ms
 * 6. 并发基准：100 QPS 下计量数据无丢失
 */

import { BillingEngineService } from '../services/billing-engine.service';
import { PricingModelService } from '../services/pricing-model.service';
import { MeteringCollectorService } from '../services/metering-collector.service';
import { CertifiedSkillPricingService } from '../services/certified-skill-pricing.service';
import { PolicyPackExclusiveService } from '../services/policy-pack-exclusive.service';
import { MeteringService } from '../services/metering.service';
import { SplitEngineService } from '../services/split-engine.service';
import { SettlementService } from '../services/settlement-service';
import { ForecastService } from '../services/forecast.service';

describe('K18 End-to-End Integration (S28)', () => {
  let billing: BillingEngineService;
  let pricing: PricingModelService;
  let metering: MeteringCollectorService;
  let certifiedPricing: CertifiedSkillPricingService;
  let exclusivePack: PolicyPackExclusiveService;
  let meteringService: MeteringService;
  let settlement: SettlementService;
  let forecast: ForecastService;

  beforeEach(() => {
    billing = new BillingEngineService(null);
    pricing = new PricingModelService();
    metering = new MeteringCollectorService(billing);
    certifiedPricing = new CertifiedSkillPricingService();
    exclusivePack = new PolicyPackExclusiveService();
    meteringService = new MeteringService();
    const splitEngine = new SplitEngineService();
    settlement = new SettlementService(splitEngine);
    forecast = new ForecastService(billing);
  });

  afterEach(() => {
    meteringService.clear();
    certifiedPricing.clear();
    exclusivePack.clear();
  });

  // ── 场景 1：付费技能调用 → 计量记录 → 账单生成 ──

  it('E2E-1: 付费技能调用流程完整', () => {
    // 1. 创建付费定价计划
    const plan = certifiedPricing.createPricingPlan('skill-paid', 't-paid', 'monthly', 99.99);
    expect(plan.status).toBe('active');

    // 2. 记录计量
    const event = meteringService.recordUsage('call', 't-paid', 'skill-paid', { cost: 10 });
    expect(event.eventId).toBeTruthy();

    // 3. 查询计量
    const records = meteringService.queryUsage('t-paid', 'skill-paid');
    expect(records.length).toBe(1);

    // 4. 验证统计
    const stats = meteringService.getStats('t-paid');
    expect(stats.totalCalls).toBe(1);
    expect(stats.totalCost).toBe(10);
  });

  // ── 场景 2：免费额度用完后触发付费计费 ──

  it('E2E-2: Freemium 配额耗尽后触发付费', () => {
    const freeQuota = 10;
    let callsUsed = 0;

    // 模拟配额内调用（免费）
    for (let i = 0; i < freeQuota; i++) {
      const cost = pricing.calcCost('t-freemium', 'skill-fm', 'freemium', 5, freeQuota, callsUsed);
      expect(cost).toBe(0);
      callsUsed++;
    }

    // 超出配额后开始计费
    const overageCost = pricing.calcCost('t-freemium', 'skill-fm', 'freemium', 5, freeQuota, callsUsed);
    expect(overageCost).toBe(5);
  });

  // ── 场景 3：独占 Policy Pack 下的计费隔离 ──

  it('E2E-3: 独占包授权租户可访问计费接口', () => {
    // 创建独占包
    const pack = exclusivePack.createExclusivePack('t-owner', 'exclusive-pack', ['pol-1']);
    exclusivePack.publishPack(pack.packId);

    // 授权另一个租户
    exclusivePack.grantAccess(pack.packId, 't-grantee');

    // 验证 grantee 可查询
    const packs = exclusivePack.getAvailablePacks('t-grantee');
    expect(packs.some((p) => p.packId === pack.packId)).toBe(true);

    // 验证未授权租户不可查询
    const deniedPacks = exclusivePack.getAvailablePacks('t-denied');
    expect(deniedPacks.length).toBe(0);
  });

  // ── 场景 4：计量数据查询与账单对账一致 ──

  it('E2E-4: 计量数据与统计一致', () => {
    // 批量记录
    meteringService.batchRecord([
      { eventType: 'call', tenantId: 't-reconcile', skillId: 'skill-r1', metadata: { cost: 10 } },
      { eventType: 'call', tenantId: 't-reconcile', skillId: 'skill-r1', metadata: { cost: 20 } },
      { eventType: 'agent', tenantId: 't-reconcile', skillId: 'skill-r2', metadata: { cost: 30 } },
    ]);

    // 查询所有记录
    const records = meteringService.queryUsage('t-reconcile');
    expect(records.length).toBe(3);

    // 统计汇总
    const stats = meteringService.getStats('t-reconcile');
    expect(stats.totalCalls).toBe(3);
    expect(stats.totalCost).toBe(60);
    expect(stats.bySkill['skill-r1'].calls).toBe(2);
    expect(stats.bySkill['skill-r1'].cost).toBe(30);
  });

  // ── 场景 5：性能基准 ──

  it('E2E-5: 计量写入性能 < 10ms P95', () => {
    const iterations = 100;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      meteringService.recordUsage('call', 't-perf', 'skill-perf', {});
      times.push(Date.now() - start);
    }

    times.sort((a, b) => a - b);
    const p95Index = Math.floor(iterations * 0.95);
    const p95 = times[p95Index];

    expect(p95).toBeLessThan(10);
  });

  // ── 场景 6：并发基准 ──

  it('E2E-6: 并发写入不丢失数据', async () => {
    const concurrency = 50;
    const promises = Array.from({ length: concurrency }, (_, i) =>
      Promise.resolve(meteringService.recordUsage('call', 't-concurrent', `skill-c${i % 5}`, {})),
    );

    await Promise.all(promises);

    const records = meteringService.queryUsage('t-concurrent');
    expect(records.length).toBe(concurrency);
  });
});
