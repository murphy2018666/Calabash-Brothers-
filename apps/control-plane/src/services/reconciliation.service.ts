import { Injectable, Logger } from '@nestjs/common';
import { MonthlyBill, Settlement, SplitRecord } from '@aegisci/shared/types';

export interface Discrepancy {
  discrepancyId: string;
  tenantId: string;
  period: string;
  type: 'calls' | 'cost';
  meteringValue: number;
  settlementValue: number;
  diff: number;
  diffPct: number;
  severity: 'warning' | 'critical';
  status: 'pending' | 'acknowledged' | 'resolved';
  createdAt: string;
  acknowledgedAt?: string;
}

/**
 * 结算对账服务（K15-3）。
 *
 * 对比 MeteringRecord 累计值与 Settlement 结算值，检测差异。
 */
@Injectable()
export class ReconciliationService {
  private readonly logger = new Logger(ReconciliationService.name);

  /** 阈值配置 */
  private static readonly WARNING_PCT = 0.01;
  private static readonly CRITICAL_PCT = 0.05;

  private readonly discrepancies = new Map<string, Discrepancy>();

  /**
   * 检测指定租户和周期的差异。
   * @param tenantId 租户 ID
   * @param period yyyy-MM 格式
   * @param totalCalls 计量总调用数
   * @param totalCost 计量总成本
   * @param settlement 结算记录（可多条）
   */
  detectDiscrepancies(
    tenantId: string,
    period: string,
    totalCalls: number,
    totalCost: number,
    settlements: Settlement[],
  ): Discrepancy[] {
    const detected: Discrepancy[] = [];

    for (const settlement of settlements) {
      if (settlement.period !== period) continue;

      // 调用数差异（Settlement 无 skillCalls，用 splitRecords 数量作占位）
      const settlementCalls = settlement.splitRecords.length; // 仅用于有/无结算时的区分
      this._checkAndCreate(tenantId, period, settlement, 'calls', totalCalls, settlementCalls, detected);

      // 成本差异
      const settlementCost = settlement.splitRecords.reduce((s, r) => s + r.skillOwnerAmount, 0);
      this._checkAndCreate(tenantId, period, settlement, 'cost', totalCost, settlementCost, detected);
    }

    return detected;
  }

  /** 查询差异列表 */
  listDiscrepancies(tenantId: string, status?: string): Discrepancy[] {
    const results = Array.from(this.discrepancies.values()).filter((d) => d.tenantId === tenantId);
    if (status) {
      return results.filter((d) => d.status === status);
    }
    return results;
  }

  /** 确认差异 */
  acknowledgeDiscrepancy(discrepancyId: string, tenantId: string): Discrepancy | null {
    const disc = this.discrepancies.get(discrepancyId);
    if (!disc || disc.tenantId !== tenantId) return null;
    disc.status = 'acknowledged';
    disc.acknowledgedAt = new Date().toISOString();
    return disc;
  }

  /** 测试用清空 */
  clear(): void {
    this.discrepancies.clear();
  }

  /**
   * 自动对账：对所有 pending 差异，若 diffPct ≤ WARNING_PCT 则自动 resolved。
   * 适用于微小差异（< 1%）的自动闭环。
   */
  autoReconcile(tenantId: string): Discrepancy[] {
    const pending = this.listDiscrepancies(tenantId, 'pending');
    const reconciled: Discrepancy[] = [];
    for (const disc of pending) {
      if (disc.diffPct <= ReconciliationService.WARNING_PCT) {
        disc.status = 'resolved';
        disc.acknowledgedAt = new Date().toISOString();
        reconciled.push(disc);
      }
    }
    return reconciled;
  }

  /**
   * 手动解决差异：将指定差异状态改为 resolved。
   */
  resolveDiscrepancy(discrepancyId: string, tenantId: string): Discrepancy | null {
    const disc = this.discrepancies.get(discrepancyId);
    if (!disc || disc.tenantId !== tenantId) return null;
    disc.status = 'resolved';
    disc.acknowledgedAt = new Date().toISOString();
    return disc;
  }

  // ── 私有辅助 ──

  private _checkAndCreate(
    tenantId: string,
    period: string,
    settlement: Settlement,
    type: 'calls' | 'cost',
    meteringValue: number,
    settlementValue: number,
    detected: Discrepancy[],
  ): void {
    if (meteringValue === 0 && settlementValue === 0) return;
    const diff = Math.abs(meteringValue - settlementValue);
    const base = Math.max(Math.abs(meteringValue), Math.abs(settlementValue), 1);
    const diffPct = diff / base;

    if (diffPct > 0) {
      const severity = diffPct >= ReconciliationService.CRITICAL_PCT ? 'critical' : 'warning';
      const discrepancyId = `${tenantId}-${period}-${type}-${settlement.settlementId}`;
      const disc: Discrepancy = {
        discrepancyId,
        tenantId,
        period,
        type,
        meteringValue,
        settlementValue,
        diff,
        diffPct: parseFloat(diffPct.toFixed(4)),
        severity,
        status: 'pending',
        createdAt: new Date().toISOString(),
      };
      this.discrepancies.set(discrepancyId, disc);
      detected.push(disc);
    }
  }
}
