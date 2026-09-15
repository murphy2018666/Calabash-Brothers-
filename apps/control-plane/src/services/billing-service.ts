import { Injectable, Logger } from '@nestjs/common';
import { BillingEngineService } from './billing-engine.service';
import {
  type MonthlyBill,
  type MeteringRecord,
  type MeteringResponse,
  type PricingTier,
} from '@aegisci/shared/types';

/**
 * 计费服务（K10-3）。
 *
 * 职责：账单管理、计量查询、定价档位查询、导出。
 */
@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);

  constructor(private readonly billingEngine: BillingEngineService) {}

  // ── 计量查询 ──

  /** 查询计量记录（分页） */
  getMetering(
    tenantId: string,
    skillId?: string,
    from?: string,
    to?: string,
    page = 1,
    pageSize = 50,
  ): MeteringResponse {
    const records = this.billingEngine.getMetering(tenantId, skillId, from, to);
    const start = (page - 1) * pageSize;
    const paged = records.slice(start, start + pageSize);
    const totalCost = records.reduce((sum, r) => sum + (r.cost ?? 0), 0);

    return {
      records: paged,
      total: records.length,
      page,
      pageSize,
      totalCost: parseFloat(totalCost.toFixed(6)),
    };
  }

  // ── 账单管理 ──

  /** 生成月度账单 */
  generateBill(tenantId: string, period: string): MonthlyBill {
    return this.billingEngine.generateBill(tenantId, period);
  }

  /** 导出账单为 CSV 格式 */
  exportBillCsv(bill: MonthlyBill): string {
    const header = 'skillId,name,calls,unitPrice,subtotal\n';
    const rows = bill.lineItems
      .map(
        (item) =>
          `${item.skillId},"${item.name}",${item.calls},${item.unitPrice},${item.subtotal}`,
      )
      .join('\n');
    return header + rows;
  }

  /** 导出账单为 JSON 格式 */
  exportBillJson(bill: MonthlyBill): string {
    return JSON.stringify(bill, null, 2);
  }

  // ── 定价档位 ──

  /** 获取所有可用的定价档位列表 */
  getPricingTiers(): PricingTier[] {
    return ['free', 'freemium', 'subscription', 'usage'];
  }

  /** 获取指定技能在当前租户的定价模型 */
  getPricingModel(tenantId: string, skillId: string): unknown {
    return this.billingEngine.getPricingTier(tenantId, skillId);
  }

  // ── 统计 ──

  /** 获取租户计量统计 */
  getStats(tenantId: string): { totalCalls: number; totalCost: number } {
    return this.billingEngine.getStats(tenantId);
  }

  /** 获取 TOP N 技能调用排行 */
  getTopSkills(tenantId: string, limit = 10): Array<{ skillId: string; calls: number; cost: number }> {
    const records = this.billingEngine.getMetering(tenantId);
    const skillMap = new Map<string, { calls: number; cost: number }>();

    for (const record of records) {
      const entry = skillMap.get(record.skillId) ?? { calls: 0, cost: 0 };
      entry.calls += 1;
      entry.cost += record.cost ?? 0;
      skillMap.set(record.skillId, entry);
    }

    return Array.from(skillMap.entries())
      .map(([skillId, data]) => ({ skillId, ...data, cost: parseFloat(data.cost.toFixed(6)) }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, limit);
  }
}
