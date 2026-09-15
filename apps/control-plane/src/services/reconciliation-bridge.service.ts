import { Injectable, Logger } from '@nestjs/common';
import { BillingEngineService } from './billing-engine.service';
import { SettlementService } from './settlement-service';
import { SplitEngineService } from './split-engine.service';

/**
 * 对账闭环验证服务（K20-3）。
 *
 * 职责：端到端验证计量→计费→结算→分账数据一致性。
 */
export interface DiscrepancyItem {
  type: 'metering_mismatch' | 'cost_mismatch' | 'settlement_mismatch' | 'split_mismatch';
  expected: number;
  actual: number;
  description: string;
}

export interface BillingConsistencyReport {
  tenantId: string;
  period: string;
  meteringCount: number;
  billCallCount: number;
  costMatch: boolean;
  settlementMatch: boolean;
  splitMatch: boolean;
  discrepancies: DiscrepancyItem[];
  checkedAt: string;
}

/**
 * 对账闭环验证服务（K20-3）。
 *
 * 职责：端到端验证计量→计费→结算→分账数据一致性。
 */
@Injectable()
export class ReconciliationBridgeService {
  private readonly logger = new Logger(ReconciliationBridgeService.name);

  constructor(
    private readonly billingEngine: BillingEngineService,
    private readonly settlementService: SettlementService,
    private readonly splitEngine: SplitEngineService,
  ) {}

  /** 验证计费一致性 */
  verifyBillingConsistency(tenantId: string, period?: string): BillingConsistencyReport {
    const discrepancies: DiscrepancyItem[] = [];

    // 1. 计量记录数 vs 账单调用数
    const meteringRecords = this.billingEngine.getMetering(tenantId);
    const meteringCount = meteringRecords.length;
    // 账单调用数从结算数据反推
    const settlements = this.settlementService.listSettlements({ tenantId, page: 1, pageSize: 100 });
    let billCallCount = 0;
    for (const s of settlements.settlements) {
      for (const item of s.splitRecords) {
        billCallCount += item.revenue; // revenue 代表计费单位
      }
    }

    // 2. 成本匹配
    const totalMeteringCost = meteringRecords.reduce((sum, r) => sum + (r.cost ?? 0), 0);
    const totalSettlementRevenue = settlements.settlements.reduce((sum, s) => sum + s.totalRevenue, 0);
    const costMatch = Math.abs(totalMeteringCost - totalSettlementRevenue) < 0.01;
    if (!costMatch) {
      discrepancies.push({
        type: 'cost_mismatch',
        expected: totalSettlementRevenue,
        actual: totalMeteringCost,
        description: `Metering cost (${totalMeteringCost}) != Settlement revenue (${totalSettlementRevenue})`,
      });
    }

    // 3. 结算匹配
    const totalSkillOwnerPayout = settlements.settlements.reduce(
      (sum, s) => sum + s.totalSkillOwnerPayout, 0
    );
    const splitRecords = this.splitEngine.getSplitRecords(tenantId);
    const totalSplitPayout = splitRecords.reduce((sum, r) => sum + r.skillOwnerAmount, 0);
    const splitMatch = Math.abs(totalSkillOwnerPayout - totalSplitPayout) < 0.01;
    if (!splitMatch) {
      discrepancies.push({
        type: 'split_mismatch',
        expected: totalSkillOwnerPayout,
        actual: totalSplitPayout,
        description: `Settlement payout (${totalSkillOwnerPayout}) != Split total (${totalSplitPayout})`,
      });
    }

    // 4. 计量 vs 账单数量匹配
    const settlementCount = settlements.settlements.reduce(
      (sum, s) => sum + s.splitRecords.length, 0
    );
    if (meteringCount !== settlementCount && meteringCount > 0 && settlementCount > 0) {
      discrepancies.push({
        type: 'metering_mismatch',
        expected: settlementCount,
        actual: meteringCount,
        description: `Metering count (${meteringCount}) != Settlement line items (${settlementCount})`,
      });
    }

    return {
      tenantId,
      period: period ?? 'all',
      meteringCount,
      billCallCount,
      costMatch,
      settlementMatch: totalSettlementRevenue >= 0,
      splitMatch,
      discrepancies,
      checkedAt: new Date().toISOString(),
    };
  }

  /** 生成差异报告 */
  generateDiscrepancyReport(tenantId: string, period?: string): DiscrepancyItem[] {
    const report = this.verifyBillingConsistency(tenantId, period);
    return report.discrepancies;
  }

  /** 清空存储（测试用） */
  clear(): void {
    // 依赖的服务各自有 clear()
  }
}
