/**
 * K20 全链路闭环集成测试（K20-5）
 *
 * 验证订阅续约 → 认证计费 → 结算 → 对账完整链路
 */
import { Test, TestingModule } from '@nestjs/testing';
import { BillingEngineService } from '../services/billing-engine.service';
import { MeteringService } from '../services/metering.service';
import { CertifiedSkillPricingService } from '../services/certified-skill-pricing.service';
import { SettlementService } from '../services/settlement-service';
import { SplitEngineService } from '../services/split-engine.service';
import { CertificationEngineService } from '../services/certification-engine.service';
import { AutoRenewalService } from '../services/auto-renewal.service';
import { CertificationBillingHookService } from '../services/certification-billing-hook.service';
import { ReconciliationBridgeService } from '../services/reconciliation-bridge.service';
import { PolicyPackExclusiveService } from '../services/policy-pack-exclusive.service';
import { type MonthlyBill, type MeteringRecord } from '@aegisci/shared/types';

describe('K20 Closing Loop E2E (K20-5)', () => {
  let billing: BillingEngineService;
  let metering: MeteringService;
  let pricing: CertifiedSkillPricingService;
  let settlement: SettlementService;
  let splitEngine: SplitEngineService;
  let certification: CertificationEngineService;
  let autoRenewal: AutoRenewalService;
  let billingHook: CertificationBillingHookService;
  let reconciliation: ReconciliationBridgeService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingEngineService,
        MeteringService,
        CertifiedSkillPricingService,
        SettlementService,
        SplitEngineService,
        CertificationEngineService,
        AutoRenewalService,
        CertificationBillingHookService,
        ReconciliationBridgeService,
        PolicyPackExclusiveService,
      ],
    }).compile();

    billing = module.get<BillingEngineService>(BillingEngineService);
    metering = module.get<MeteringService>(MeteringService);
    pricing = module.get<CertifiedSkillPricingService>(CertifiedSkillPricingService);
    settlement = module.get<SettlementService>(SettlementService);
    splitEngine = module.get<SplitEngineService>(SplitEngineService);
    certification = module.get<CertificationEngineService>(CertificationEngineService);
    autoRenewal = module.get<AutoRenewalService>(AutoRenewalService);
    billingHook = module.get<CertificationBillingHookService>(CertificationBillingHookService);
    reconciliation = module.get<ReconciliationBridgeService>(ReconciliationBridgeService);
  });

  afterEach(() => {
    billing.clear();
    metering.clear();
    pricing.clear();
    settlement.clear();
    splitEngine.clear();
    certification.clear();
    autoRenewal.clear();
  });

  // ── E2E-1: 免费技能 → 计量 → 账单 = 0，对账一致 ──

  it('E2E-1: free skill metering → zero billing → consistent reconciliation', () => {
    billing.recordCall({
      recordId: 'e2e-1',
      tenantId: 'tenant-free',
      skillId: 'free-skill',
      callAt: new Date().toISOString(),
      durationMs: 100,
      cost: 0,
      usageType: 'tool',
      evidenceId: 'ev-1',
      traceSpanId: 'span-1',
    } as MeteringRecord);

    const report = reconciliation.verifyBillingConsistency('tenant-free');
    expect(report.meteringCount).toBe(1);
    expect(report.costMatch).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
  });

  // ── E2E-2: 订阅技能 → 到期续约 → 续期后继续计费 ──

  it('E2E-2: subscription skill → renewal → continued billing after renewal', () => {
    const now = new Date().toISOString();
    const plan = pricing.createPricingPlan('skill-sub', 'tenant-sub', 'monthly', 50.0);
    autoRenewal.scheduleRenewal(plan.planId, 'tenant-sub', 'skill-sub', now, 7);

    // 处理续约
    const results = autoRenewal.processRenewals(now);
    expect(results).toHaveLength(1);
    expect(results[0].status).toBe('renewed');

    // 续约后继续计量
    billing.recordCall({
      recordId: 'e2e-2-1',
      tenantId: 'tenant-sub',
      skillId: 'skill-sub',
      callAt: now,
      durationMs: 200,
      cost: 200.0,
      usageType: 'tool',
      evidenceId: 'ev-2',
      traceSpanId: 'span-2',
    } as MeteringRecord);

    // 生成结算账单（账单金额与计量一致）
    const bill: MonthlyBill = {
      billId: 'bill-e2e-2',
      tenantId: 'tenant-sub',
      period: '2026-01',
      totalCalls: 1,
      totalCost: 200.0,
      lineItems: [{ skillId: 'skill-sub', name: 'Sub Skill', calls: 1, unitPrice: 200, subtotal: 200.0 }],
      status: 'finalized',
      createdAt: '2026-01-31T00:00:00Z',
    };
    const settlementRecord = settlement.generateSettlement(bill);
    settlement.approveSettlement(settlementRecord.settlementId);

    const report = reconciliation.verifyBillingConsistency('tenant-sub');
    expect(report.meteringCount).toBe(1);
    expect(report.costMatch).toBe(true);
  });

  // ── E2E-3: 认证技能 → 认证通过 → 切换 certified 费率 → 账单金额正确 ──

  it('E2E-3: certified skill → approved → certified rate → correct billing amount', () => {
    const cert = certification.applyCertification('skill-cert', 'tenant-cert');
    const reviewed = certification.reviewCertification(cert.certificationId, true, 'reviewer-1');

    // 认证通过 → 切换费率
    billingHook.onCertificationUpdated(reviewed);
    const model = billingHook.getCurrentSplitModel('tenant-cert', 'skill-cert');
    expect(model.ratio).toBe('certified');
    expect(model.skillOwnerPct).toBe(90);

    // 创建计费记录并结算
    billing.recordCall({
      recordId: 'e2e-3',
      tenantId: 'tenant-cert',
      skillId: 'skill-cert',
      callAt: new Date().toISOString(),
      durationMs: 100,
      cost: 10.0,
      usageType: 'tool',
      evidenceId: 'ev-3',
      traceSpanId: 'span-3',
    } as MeteringRecord);

    const bill: MonthlyBill = {
      billId: 'bill-e2e-3',
      tenantId: 'tenant-cert',
      period: '2026-01',
      totalCalls: 1,
      totalCost: 200.0,
      lineItems: [{ skillId: 'skill-cert', name: 'Cert Skill', calls: 1, unitPrice: 200, subtotal: 200.0 }],
      status: 'finalized',
      createdAt: '2026-01-31T00:00:00Z',
    };
    const settlementRecord = settlement.generateSettlement(bill);
    settlement.approveSettlement(settlementRecord.settlementId);

    // 验证分账金额（90/10）
    const splits = splitEngine.getSplitRecords('tenant-cert');
    expect(splits).toHaveLength(1);
    expect(splits[0].splitRatio).toBe('certified');
    expect(splits[0].skillOwnerAmount).toBeCloseTo(180.0, 1);
    expect(splits[0].platformAmount).toBeCloseTo(20.0, 1);
  });

  // ── E2E-4: 认证撤销 → 恢复 standard 费率 → 账单金额变化 ──

  it('E2E-4: certification revoked → restored standard rate → billing amount changes', () => {
    // 先设置认证状态
    const cert = certification.applyCertification('skill-a', 'tenant-rv');
    certification.reviewCertification(cert.certificationId, true, 'reviewer-1');
    billingHook.switchToCertifiedRate('tenant-rv', 'skill-a');

    // 撤销认证
    const suspended = certification.suspendCertification(cert.certificationId, 'dispute');
    billingHook.onCertificationUpdated(suspended);

    const model = billingHook.getCurrentSplitModel('tenant-rv', 'skill-a');
    expect(model.ratio).toBe('standard');
    expect(model.skillOwnerPct).toBe(80);

    // 创建新账单验证费率已恢复
    const bill: MonthlyBill = {
      billId: 'bill-e2e-4',
      tenantId: 'tenant-rv',
      period: '2026-02',
      totalCalls: 1,
      totalCost: 200.0,
      lineItems: [{ skillId: 'skill-a', name: 'Skill A', calls: 1, unitPrice: 200, subtotal: 200.0 }],
      status: 'finalized',
      createdAt: '2026-02-28T00:00:00Z',
    };
    const settlementRecord = settlement.generateSettlement(bill);
    settlement.approveSettlement(settlementRecord.settlementId);

    const splits = splitEngine.getSplitRecords('tenant-rv');
    expect(splits).toHaveLength(1);
    expect(splits[0].skillOwnerAmount).toBeCloseTo(160.0, 1); // 80%
    expect(splits[0].platformAmount).toBeCloseTo(40.0, 1);    // 20%
  });

  // ── E2E-5: 批量计量 → 批量结算 → 对账一致性验证 ──

  it('E2E-5: batch metering → batch settlement → reconciliation consistency', () => {
    const now = new Date().toISOString();
    const skills = ['skill-a', 'skill-b', 'skill-c'];

    // 批量计量
    const costs = [100.0, 150.0, 200.0];
    for (let i = 0; i < skills.length; i++) {
      billing.recordCall({
        recordId: `batch-${i}`,
        tenantId: 'tenant-batch',
        skillId: skills[i],
        callAt: now,
        durationMs: 100 + i * 50,
        cost: costs[i],
        usageType: 'tool',
        evidenceId: `ev-batch-${i}`,
        traceSpanId: `span-batch-${i}`,
      } as MeteringRecord);
    }

    // 批量结算（bill总成本与计量一致）
    const bill: MonthlyBill = {
      billId: 'bill-batch',
      tenantId: 'tenant-batch',
      period: '2026-01',
      totalCalls: 3,
      totalCost: 450.0,
      lineItems: skills.map((s, i) => ({
        skillId: s, name: `Skill ${s}`, calls: 1, unitPrice: costs[i], subtotal: costs[i],
      })),
      status: 'finalized',
      createdAt: '2026-01-31T00:00:00Z',
    };
    const settlementRecord = settlement.generateSettlement(bill);
    settlement.approveSettlement(settlementRecord.settlementId);

    const report = reconciliation.verifyBillingConsistency('tenant-batch');
    expect(report.meteringCount).toBe(3);
    expect(report.costMatch).toBe(true);
    expect(report.discrepancies).toHaveLength(0);
  });

  // ── E2E-6: 续约取消 → 订阅降级 → 计费停止 ──

  it('E2E-6: renewal cancelled → subscription downgraded → billing stops', () => {
    const now = new Date().toISOString();
    const plan = pricing.createPricingPlan('skill-down', 'tenant-down', 'monthly', 20.0);
    autoRenewal.scheduleRenewal(plan.planId, 'tenant-down', 'skill-down', now, 7);

    // 取消续约
    const cancelled = autoRenewal.cancelRenewal(plan.planId, 'tenant-down');
    expect(cancelled).toBe(true);

    // 验证无即将到期的续约
    const upcoming = autoRenewal.getUpcomingRenewals('tenant-down', 24);
    expect(upcoming).toHaveLength(0);

    // 再次尝试处理续约（已取消的不应该被处理）
    const results = autoRenewal.processRenewals(now);
    expect(results).toHaveLength(0);
  });

  // ── E2E-7: 全链路：metering → billing → settlement → split → reconciliation ──

  it('E2E-7: full chain metering → billing → settlement → split → reconciliation', () => {
    const now = new Date().toISOString();

    // 1. 计量
    billing.recordCall({
      recordId: 'full-1',
      tenantId: 'tenant-full',
      skillId: 'skill-full',
      callAt: now,
      durationMs: 150,
      cost: 200.0,
      usageType: 'tool',
      evidenceId: 'ev-full',
      traceSpanId: 'span-full',
    } as MeteringRecord);

    // 2. 计费账单
    const bill: MonthlyBill = {
      billId: 'bill-full',
      tenantId: 'tenant-full',
      period: '2026-01',
      totalCalls: 1,
      totalCost: 200.0,
      lineItems: [{ skillId: 'skill-full', name: 'Full Chain Skill', calls: 1, unitPrice: 200, subtotal: 200.0 }],
      status: 'finalized',
      createdAt: '2026-01-31T00:00:00Z',
    };
    const settlementRecord = settlement.generateSettlement(bill);
    settlement.approveSettlement(settlementRecord.settlementId);

    // 3. 对账验证
    const report = reconciliation.verifyBillingConsistency('tenant-full');
    expect(report.meteringCount).toBe(1);
    expect(report.costMatch).toBe(true);
    expect(report.splitMatch).toBe(true);
    expect(report.discrepancies).toHaveLength(0);

    // 4. 分账金额验证
    const splits = splitEngine.getSplitRecords('tenant-full');
    expect(splits).toHaveLength(1);
    expect(splits[0].skillOwnerAmount + splits[0].platformAmount).toBeCloseTo(200.0, 1);
  });
});
