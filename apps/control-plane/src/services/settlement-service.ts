import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import {
  type MonthlyBill,
  type SplitRecord,
  type Settlement,
  type SettlementStatus,
  type SplitModel,
} from '@aegisci/shared/types';
import { SplitEngineService } from './split-engine.service';

/**
 * 结算生命周期管理服务（K11）。
 *
 * 职责：
 * 1. 从 K10 MonthlyBill 生成 Settlement
 * 2. 管理 Settlement 状态流转（pending → approved → paid）
 * 3. 最低起付线 ¥100 拦截
 * 4. CSV 导出
 */
@Injectable()
export class SettlementService {
  private readonly logger = new Logger(SettlementService.name);

  /** 最低起付线（分） */
  private static readonly MIN_PAYOUT_THRESHOLD = 100;

  /** settlementId → Settlement */
  private readonly settlementStore = new Map<string, Settlement>();
  /** billId → Settlement[]（索引，方便按账单查询） */
  private readonly billToSettlements = new Map<string, string[]>();

  constructor(private readonly splitEngine: SplitEngineService) {}

  // ── 结算生成 ──

  /**
   * 从 K10 MonthlyBill 生成 Settlement。
   * 若总 payout < ¥100，状态为 pending（需累计到 threshold）。
   */
  generateSettlement(bill: MonthlyBill): Settlement {
    const period = bill.period;
    const tenantId = bill.tenantId;

    // 按 skillId 生成分账记录
    const splitRecords: SplitRecord[] = bill.lineItems.map((item) => {
      const model = this.splitEngine.getSplitModel(tenantId, item.skillId);
      return this.splitEngine.calculateSplit(
        bill.billId,
        tenantId,
        item.skillId,
        item.subtotal,
        model,
      );
    });

    const totalRevenue = splitRecords.reduce((sum, r) => sum + r.revenue, 0);
    const totalSkillOwnerPayout = splitRecords.reduce((sum, r) => sum + r.skillOwnerAmount, 0);
    const totalPlatformRevenue = splitRecords.reduce((sum, r) => sum + r.platformAmount, 0);

    // 最低起付线：未达 ¥100 不自动 approved
    const status: SettlementStatus =
      totalSkillOwnerPayout >= SettlementService.MIN_PAYOUT_THRESHOLD ? 'pending' : 'pending';

    const settlement: Settlement = {
      settlementId: `settle_${period}_${tenantId}`,
      tenantId,
      period,
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      totalSkillOwnerPayout: parseFloat(totalSkillOwnerPayout.toFixed(2)),
      totalPlatformRevenue: parseFloat(totalPlatformRevenue.toFixed(2)),
      splitRecords,
      status,
      createdAt: new Date().toISOString(),
    };

    this.settlementStore.set(settlement.settlementId, settlement);

    const existing = this.billToSettlements.get(bill.billId) ?? [];
    this.billToSettlements.set(bill.billId, [...existing, settlement.settlementId]);

    this.logger.log(
      `settlement generated: ${settlement.settlementId} revenue=${totalRevenue} payout=${totalSkillOwnerPayout}`,
    );
    return settlement;
  }

  // ── 状态流转 ──

  /** 审批结算：pending → approved */
  approveSettlement(settlementId: string): Settlement {
    const settlement = this.getSettlement(settlementId);

    if (settlement.status !== 'pending') {
      throw new BadRequestException(
        `cannot approve settlement with status '${settlement.status}', expected 'pending'`,
      );
    }

    // 最低起付线校验
    if (settlement.totalSkillOwnerPayout < SettlementService.MIN_PAYOUT_THRESHOLD) {
      throw new BadRequestException(
        `payout ${settlement.totalSkillOwnerPayout} is below minimum threshold ¥${SettlementService.MIN_PAYOUT_THRESHOLD}`,
      );
    }

    settlement.status = 'approved';
    settlement.approvedAt = new Date().toISOString();
    this.settlementStore.set(settlementId, settlement);

    this.logger.log(`settlement approved: ${settlementId}`);
    return settlement;
  }

  /** 支付结算：approved → paid */
  paySettlement(settlementId: string): Settlement {
    const settlement = this.getSettlement(settlementId);

    if (settlement.status !== 'approved') {
      throw new BadRequestException(
        `cannot pay settlement with status '${settlement.status}', expected 'approved'`,
      );
    }

    settlement.status = 'paid';
    settlement.paidAt = new Date().toISOString();
    this.settlementStore.set(settlementId, settlement);

    this.logger.log(`settlement paid: ${settlementId}`);
    return settlement;
  }

  /** 查询结算详情 */
  getSettlement(settlementId: string): Settlement {
    const settlement = this.settlementStore.get(settlementId);
    if (!settlement) {
      throw new BadRequestException(`settlement not found: ${settlementId}`);
    }
    return settlement;
  }

  /** 分页查询结算列表 */
  listSettlements(query: {
    tenantId: string;
    period?: string;
    status?: SettlementStatus;
    page?: number;
    pageSize?: number;
  }): { settlements: Settlement[]; total: number; page: number; pageSize: number } {
    let records = Array.from(this.settlementStore.values()).filter(
      (s) => s.tenantId === query.tenantId,
    );

    if (query.period) {
      records = records.filter((s) => s.period === query.period);
    }
    if (query.status) {
      records = records.filter((s) => s.status === query.status);
    }

    const total = records.length;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    const settlements = records.slice(start, start + pageSize);

    return { settlements, total, page, pageSize };
  }

  // ── 导出 ──

  /** 导出结算 CSV */
  exportSettlementCsv(settlement: Settlement): string {
    const lines: string[] = [
      'settlement_id,period,status,total_revenue,total_payout,total_platform_revenue,created_at',
      `${settlement.settlementId},${settlement.period},${settlement.status},${settlement.totalRevenue},${settlement.totalSkillOwnerPayout},${settlement.totalPlatformRevenue},${settlement.createdAt}`,
      '',
      'skill_id,revenue,split_ratio,skill_owner_amount,platform_amount',
    ];

    for (const record of settlement.splitRecords) {
      lines.push(
        `${record.skillId},${record.revenue},${record.splitRatio},${record.skillOwnerAmount},${record.platformAmount}`,
      );
    }

    return lines.join('\n');
  }

  /** 获取结算统计摘要 */
  getStats(tenantId: string): {
    totalRevenue: number;
    totalPayout: number;
    totalPlatformRevenue: number;
    pendingCount: number;
    approvedCount: number;
    paidCount: number;
  } {
    const records = Array.from(this.settlementStore.values()).filter(
      (s) => s.tenantId === tenantId,
    );

    const totalRevenue = records.reduce((sum, s) => sum + s.totalRevenue, 0);
    const totalPayout = records.reduce((sum, s) => sum + s.totalSkillOwnerPayout, 0);
    const totalPlatformRevenue = records.reduce((sum, s) => sum + s.totalPlatformRevenue, 0);

    return {
      totalRevenue: parseFloat(totalRevenue.toFixed(2)),
      totalPayout: parseFloat(totalPayout.toFixed(2)),
      totalPlatformRevenue: parseFloat(totalPlatformRevenue.toFixed(2)),
      pendingCount: records.filter((s) => s.status === 'pending').length,
      approvedCount: records.filter((s) => s.status === 'approved').length,
      paidCount: records.filter((s) => s.status === 'paid').length,
    };
  }

  /** 清空存储（测试用） */
  clear(): void {
    this.settlementStore.clear();
    this.billToSettlements.clear();
  }

  /** 获取所有结算记录（测试/平台汇总用） */
  getAllSettlements(): Settlement[] {
    return Array.from(this.settlementStore.values());
  }
}
