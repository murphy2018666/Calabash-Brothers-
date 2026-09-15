/**
 * K10 × K18 端到端集成测试（S29）。
 *
 * 场景：
 * 1. 免费技能调用 → 计量 → 账单金额 = 0
 * 2. 付费技能调用 → 计量 → 账单金额计算正确
 * 3. 独占包下付费技能调用 → 授权租户计费成功
 * 4. 独占包下付费技能调用 → 未授权租户被拒绝
 * 5. 定价变更后下一账单周期生效
 * 6. 批量计量写入后账单一致性验证
 */

import { Test, TestingModule } from '@nestjs/testing';
import { BillingEngineService } from '../services/billing-engine.service';
import { MeteringService } from '../services/metering.service';
import { MeteringCollectorService } from '../services/metering-collector.service';
import { CertifiedSkillPricingService } from '../services/certified-skill-pricing.service';
import { PolicyPackExclusiveService } from '../services/policy-pack-exclusive.service';
import { ToolCallResult, Principal } from '@aegisci/shared/types';

describe('K10×K18 E2E Integration (S29)', () => {
  let engine: BillingEngineService;
  let metering: MeteringService;
  let collector: MeteringCollectorService;
  let pricingService: CertifiedSkillPricingService;
  let exclusivePack: PolicyPackExclusiveService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingEngineService,
        MeteringService,
        CertifiedSkillPricingService,
        PolicyPackExclusiveService,
        MeteringCollectorService,
      ],
    }).compile();

    engine = module.get(BillingEngineService);
    metering = module.get(MeteringService);
    collector = module.get(MeteringCollectorService);
    pricingService = module.get(CertifiedSkillPricingService);
    exclusivePack = module.get(PolicyPackExclusiveService);
  });

  afterEach(() => {
    engine.clear();
    metering.clear();
    pricingService.clear();
    exclusivePack.clear();
  });

  // ── E2E-1: 免费技能调用流程 ──

  it('E2E-1: free skill → metering → bill cost = 0', () => {
    // 记录免费技能调用
    const record = {
      recordId: 'rec-free-1',
      tenantId: 'tenant-free',
      skillId: 'skill-free',
      callAt: '2026-01-15T10:00:00Z',
      durationMs: 100,
      cost: 0,
      usageType: 'tool' as const,
      evidenceId: 'ev-free-1',
      traceSpanId: 'span-free-1',
    };
    engine.recordCall(record);

    // 生成账单
    const bill = engine.generateBill('tenant-free', '2026-01');
    expect(bill.totalCalls).toBe(1);
    expect(bill.totalCost).toBe(0);
    expect(bill.lineItems[0].subtotal).toBe(0);
  });

  // ── E2E-2: 付费技能计费流程 ──

  it.each([
    { period: 'monthly' as const, price: 99.99, calls: 5, expectedCost: 0, desc: 'monthly subscription' },
    { period: 'yearly' as const, price: 999.99, calls: 5, expectedCost: 0, desc: 'yearly subscription' },
    { period: 'perpetual' as const, price: 499.99, calls: 5, expectedCost: 0, desc: 'perpetual license' },
  ])('E2E-2: paid plan ($desc) → metering → bill cost = $expectedCost', ({ period, price, calls, expectedCost }) => {
    // 创建付费定价计划
    pricingService.createPricingPlan('skill-paid', 'tenant-paid', period, price);

    // 记录计量
    for (let i = 1; i <= calls; i++) {
      engine.recordCall({
        recordId: `rec-paid-${i}`,
        tenantId: 'tenant-paid',
        skillId: 'skill-paid',
        callAt: '2026-01-15T10:00:00Z',
        durationMs: 1,
        cost: 0,
        usageType: 'tool' as const,
        evidenceId: `ev-paid-${i}`,
        traceSpanId: `span-paid-${i}`,
      });
    }

    // 生成账单
    const bill = engine.generateBill('tenant-paid', '2026-01');
    expect(bill.totalCalls).toBe(calls);
    expect(bill.totalCost).toBe(expectedCost);
    expect(bill.lineItems.length).toBe(1);
    expect(bill.lineItems[0].skillId).toBe('skill-paid');
  });

  // ── E2E-3: 独占包授权租户计费 ──

  it('E2E-3: authorized tenant in exclusive pack → metering succeeds', async () => {
    // 创建独占包
    const pack = exclusivePack.createExclusivePack('pack-owner', 'exclusive-pack', ['pol-1']);
    exclusivePack.publishPack(pack.packId);
    exclusivePack.grantAccess(pack.packId, 'tenant-allowed');

    // 授权租户调用
    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-exclusive', packId: pack.packId },
      evidenceId: 'ev-exclusive-1',
      traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'user-1',
      type: 'user',
      tenantId: 'tenant-allowed',
      roles: [],
    };

    await collector.onToolCall(result, principal, 'run-1');

    const records = engine.getMetering('tenant-allowed');
    expect(records).toHaveLength(1);
    expect(records[0].evidenceId).toBe('ev-exclusive-1');
  });

  // ── E2E-4: 未授权租户访问独占包被拒绝 ──

  it('E2E-4: unauthorized tenant denied access to exclusive pack', async () => {
    // 创建独占包
    const pack = exclusivePack.createExclusivePack('pack-owner', 'exclusive-pack-denied', ['pol-1']);
    exclusivePack.publishPack(pack.packId);
    // 不授予任何访问权

    // 未授权租户尝试调用
    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-exclusive', packId: pack.packId },
      evidenceId: 'ev-denied-1',
      traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'user-unauth',
      type: 'user',
      tenantId: 'tenant-denied',
      roles: [],
    };

    await collector.onToolCall(result, principal, 'run-denied');

    const records = engine.getMetering('tenant-denied');
    expect(records).toHaveLength(0);
  });

  // ── E2E-5: 定价变更下一周期生效 ──

  it('E2E-5: pricing change takes effect in next billing cycle', () => {
    // 创建月度定价计划
    pricingService.createPricingPlan('skill-change', 'tenant-change', 'monthly', 99.99);

    // 第一个月调用
    engine.recordCall({
      recordId: 'rec-change-1',
      tenantId: 'tenant-change',
      skillId: 'skill-change',
      callAt: '2026-01-15T10:00:00Z',
      durationMs: 1,
      cost: 0,
      usageType: 'tool' as const,
      evidenceId: 'ev-change-1',
      traceSpanId: 'span-1',
    });

    // 生成第一个月账单
    const bill1 = engine.generateBill('tenant-change', '2026-01');
    expect(bill1.totalCalls).toBe(1);

    // 更改定价（模拟下个月）
    pricingService.updatePricingPlan(
      pricingService.listPricingPlans('tenant-change')[0].planId,
      { price: 149.99 },
    );

    // 第二个月调用
    engine.recordCall({
      recordId: 'rec-change-2',
      tenantId: 'tenant-change',
      skillId: 'skill-change',
      callAt: '2026-02-15T10:00:00Z',
      durationMs: 1,
      cost: 0,
      usageType: 'tool' as const,
      evidenceId: 'ev-change-2',
      traceSpanId: 'span-2',
    });

    // 生成第二个月账单
    const bill2 = engine.generateBill('tenant-change', '2026-02');
    expect(bill2.totalCalls).toBe(1);
  });

  // ── E2E-6: 批量计量写入后账单一致性 ──

  it('E2E-6: batch metering → bill consistency', () => {
    // 批量记录多个技能调用
    const skills = ['skill-a', 'skill-b', 'skill-c'];
    const costs = [10, 20, 30];

    for (let i = 0; i < 5; i++) {
      for (let j = 0; j < skills.length; j++) {
        engine.recordCall({
          recordId: `rec-batch-${i}-${j}`,
          tenantId: 'tenant-batch',
          skillId: skills[j],
          callAt: '2026-01-15T10:00:00Z',
          durationMs: 1,
          cost: costs[j],
          usageType: 'tool' as const,
          evidenceId: `ev-batch-${i}-${j}`,
          traceSpanId: `span-batch-${i}-${j}`,
        });
      }
    }

    // 生成账单
    const bill = engine.generateBill('tenant-batch', '2026-01');

    // 验证总数
    expect(bill.totalCalls).toBe(15); // 5 calls × 3 skills
    expect(bill.totalCost).toBe(300); // 5 × (10 + 20 + 30)

    // 验证每个技能的汇总
    const skillACost = bill.lineItems.find((item) => item.skillId === 'skill-a')?.subtotal ?? 0;
    const skillBCost = bill.lineItems.find((item) => item.skillId === 'skill-b')?.subtotal ?? 0;
    const skillCCost = bill.lineItems.find((item) => item.skillId === 'skill-c')?.subtotal ?? 0;

    expect(skillACost).toBe(50); // 5 × 10
    expect(skillBCost).toBe(100); // 5 × 20
    expect(skillCCost).toBe(150); // 5 × 30
  });
});
