import { Injectable, Logger } from '@nestjs/common';
import {
  type MeteringRecord,
  type MonthlyBill,
  type PricingModel,
  type BillLineItem,
} from '@aegisci/shared/types';
import { MeteringService, type UsageEvent } from './metering.service';
import { CertifiedSkillPricingService, type PricingPlan } from './certified-skill-pricing.service';

/**
 * 计量计费引擎核心（K10）。
 *
 * 职责：
 * 1. 通过 MeteringService 记录调用计量（幂等，基于 evidenceId）
 * 2. 按四档定价模型计算费用
 * 3. 生成月度账单
 */
@Injectable()
export class BillingEngineService {
  private readonly logger = new Logger(BillingEngineService.name);

  /** tenantId/skillId → PricingModel（stub：production 应对接配置中心） */
  private readonly pricingStore = new Map<string, Map<string, PricingModel>>();

  constructor(
    private readonly metering: MeteringService,
    private readonly pricingService: CertifiedSkillPricingService,
  ) {}

  // ── 计量入口 ──

  /** 记录一次调用（幂等：相同 evidenceId 不重复写入） */
  recordCall(record: MeteringRecord): void {
    if (!record.evidenceId) return;
    // 幂等检查：通过 MeteringService 查询是否已有相同 evidenceId
    const existing = this.metering.queryUsage(record.tenantId, record.skillId).some(
      (e) => e.metadata?.evidenceId === record.evidenceId,
    );
    if (existing) {
      this.logger.debug(`duplicate metering record skipped: ${record.evidenceId}`);
      return;
    }
    this.metering.recordUsage('tool', record.tenantId, record.skillId, {
      evidenceId: record.evidenceId,
      traceSpanId: record.traceSpanId,
      durationMs: record.durationMs,
      usageType: record.usageType,
      cost: record.cost,
      callAt: record.callAt,
    });
    this.logger.debug(`metered: ${record.evidenceId} → ${record.skillId} cost=${record.cost}`);
  }

  /** 查询所有计量记录（不限租户，用于预测等服务） */
  getAllMetering(): MeteringRecord[] {
    // 遍历所有租户查询（注意：生产环境应对接数据库直接查询）
    const allEvents = this.metering['store'] ? this.metering['store'].values() : [];
    return Array.from(allEvents).map((e) => ({
      recordId: e.eventId,
      tenantId: e.tenantId,
      skillId: e.skillId,
      callAt: e.callAt,
      durationMs: (e.metadata.durationMs as number) ?? 1,
      cost: e.cost,
      usageType: (e.metadata.usageType as string) ?? 'tool',
      evidenceId: (e.metadata.evidenceId as string) ?? e.eventId,
      traceSpanId: (e.metadata.traceSpanId as string) ?? '',
    }));
  }

  /** 查询计量记录（支持按 tenantId/skillId/时间范围过滤） */
  getMetering(
    tenantId: string,
    skillId?: string,
    from?: string,
    to?: string,
  ): MeteringRecord[] {
    const events = this.metering.queryUsage(tenantId, skillId, from, to);
    return events.map((e) => ({
      recordId: e.eventId,
      tenantId: e.tenantId,
      skillId: e.skillId,
      callAt: e.callAt,
      durationMs: (e.metadata.durationMs as number) ?? 1,
      cost: e.cost,
      usageType: (e.metadata.usageType as string) ?? 'tool',
      evidenceId: (e.metadata.evidenceId as string) ?? e.eventId,
      traceSpanId: (e.metadata.traceSpanId as string) ?? '',
    }));
  }

  // ── 计费计算 ──

  /** 计算单次调用的费用 */
  calcCost(record: MeteringRecord, pricing: PricingModel): number {
    switch (pricing.tier) {
      case 'free':
        return 0;

      case 'usage':
        return (pricing.perCallPrice ?? 0) * record.durationMs;

      case 'freemium': {
        const tenantRecords = this.getMetering(record.tenantId, record.skillId);
        const usageCount = tenantRecords.filter(
          (r) => r.callAt <= record.callAt,
        ).length;
        if (usageCount <= (pricing.monthlyQuota ?? Infinity)) {
          return 0;
        }
        return (pricing.perCallPrice ?? 0) * record.durationMs;
      }

      case 'subscription': {
        const tenantRecords = this.getMetering(record.tenantId, record.skillId);
        const usageCount = tenantRecords.filter(
          (r) => r.callAt <= record.callAt,
        ).length;
        if (usageCount <= (pricing.monthlyQuota ?? Infinity)) {
          return 0;
        }
        const overage = usageCount - (pricing.monthlyQuota ?? Infinity);
        return (pricing.overagePrice ?? 0) * overage;
      }

      default:
        return 0;
    }
  }

  // ── 定价管理 ──

  /** 获取技能的定价模型 */
  getPricingTier(tenantId: string, skillId: string): PricingModel {
    const tenantPricing = this.pricingStore.get(tenantId) ?? new Map();
    return tenantPricing.get(skillId) ?? { tier: 'free' };
  }

  /** 设置技能的定价模型 */
  setPricingModel(tenantId: string, skillId: string, model: PricingModel): void {
    const tenantPricing = this.pricingStore.get(tenantId) ?? new Map();
    tenantPricing.set(skillId, model);
    this.pricingStore.set(tenantId, tenantPricing);
  }

  /**
   * 获取付费定价计划（来自 CertifiedSkillPricingService）
   * 返回 PricingModel 格式，兼容现有计费逻辑
   */
  getPricingPlan(tenantId: string, skillId: string): PricingModel | null {
    const plan = this.pricingService.getPricingPlan(skillId, tenantId);
    if (!plan) return null;

    // 将 PricingPlan 转换为 PricingModel 格式
    const base: PricingModel = { tier: 'subscription' };

    if (plan.period === 'monthly') {
      base.monthlyQuota = Infinity; // 月度订阅无调用次数限制
      base.perCallPrice = 0;
      return base;
    }

    if (plan.period === 'yearly') {
      base.monthlyQuota = Infinity;
      base.perCallPrice = 0;
      return base;
    }

    // perpetual: 一次性付费，永久使用
    base.monthlyQuota = Infinity;
    base.perCallPrice = 0;
    return base;
  }

  // ── 账单生成 ──

  /** 生成月度账单 */
  generateBill(tenantId: string, period: string): MonthlyBill {
    const [yearStr, monthStr] = period.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(parseInt(year), parseInt(month) + 1, 0).getDate();
    const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const records = this.getMetering(tenantId, undefined, from, to);

    const skillMap = new Map<
      string,
      { skillId: string; name: string; calls: number; cost: number }
    >();

    for (const record of records) {
      const entry = skillMap.get(record.skillId) ?? {
        skillId: record.skillId,
        name: record.skillId,
        calls: 0,
        cost: 0,
      };
      entry.calls += 1;
      entry.cost += record.cost ?? 0;
      skillMap.set(record.skillId, entry);
    }

    const lineItems: BillLineItem[] = Array.from(skillMap.values()).map((item) => ({
      skillId: item.skillId,
      name: item.name,
      calls: item.calls,
      unitPrice: item.calls > 0 ? parseFloat((item.cost / item.calls).toFixed(6)) : 0,
      subtotal: parseFloat(item.cost.toFixed(6)),
    }));

    const totalCost = lineItems.reduce((sum, item) => sum + item.subtotal, 0);

    return {
      billId: `bill_${period}_${tenantId}`,
      tenantId,
      period,
      totalCalls: records.length,
      totalCost: parseFloat(totalCost.toFixed(6)),
      lineItems,
      status: 'draft',
      createdAt: new Date().toISOString(),
    };
  }

  /** 获取统计摘要 */
  getStats(tenantId: string): { totalCalls: number; totalCost: number } {
    const records = this.getMetering(tenantId);
    const totalCalls = records.length;
    const totalCost = records.reduce((sum, r) => sum + (r.cost ?? 0), 0);
    return { totalCalls, totalCost: parseFloat(totalCost.toFixed(6)) };
  }

  /** 测试用清空 */
  clear(): void {
    this.metering?.clear();
    this.pricingStore.clear();
    this.pricingService?.clear();
  }
}
