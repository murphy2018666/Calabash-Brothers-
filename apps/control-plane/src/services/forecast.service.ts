import { Injectable, Logger } from '@nestjs/common';
import { BillingEngineService } from './billing-engine.service';
import { MonthlyBill } from '@aegisci/shared/types';

export interface ForecastResult {
  /** 预测下月总收入 */
  predictedRevenue: number;
  /** 预测方法：'linear' | 'exponential' */
  method: 'linear' | 'exponential';
  /** 趋势方向：'up' | 'down' | 'stable' */
  trend: 'up' | 'down' | 'stable';
  /** 历史数据点数 */
  dataPoints: number;
  /** 95% 置信区间下限 */
  lowerBound: number;
  /** 95% 置信区间上限 */
  upperBound: number;
  /** 是否因样本不足而无法预测 */
  insufficientData: boolean;
}

export interface HistoricalRevenuePoint {
  month: string;
  revenue: number;
}

/**
 * 收入预测服务（K16）。
 *
 * 基于历史账单数据提供线性/指数趋势预测。
 * 样本不足（< 3 个月）时返回 insufficientData=true，不抛出异常。
 */
@Injectable()
export class ForecastService {
  private readonly logger = new Logger(ForecastService.name);

  /** 最小样本月份数，低于此值不做预测 */
  private static readonly MIN_DATA_POINTS = 3;
  /** 95% 置信水平对应的 t 值近似 */
  private static readonly CONFIDENCE_FACTOR = 1.96;

  constructor(private readonly billingEngine: BillingEngineService) {}

  /**
   * 预测未来收入。
   * @param tenantId 租户 ID，为空时聚合全平台
   * @param periodCount 预测期数（月），默认 3
   * @param method 预测方法：'linear' | 'exponential'，默认 'linear'
   */
  predict(
    tenantId?: string,
    periodCount: number = 3,
    method: 'linear' | 'exponential' = 'linear',
  ): ForecastResult {
    const months = this._getHistoricalMonths(tenantId, 12);

    // 只保留有实际收入的月份用于预测
    const nonZeroMonths = months.filter((m) => m.revenue > 0);

    if (nonZeroMonths.length < ForecastService.MIN_DATA_POINTS) {
      return {
        predictedRevenue: 0,
        method,
        trend: 'stable',
        dataPoints: nonZeroMonths.length,
        lowerBound: 0,
        upperBound: 0,
        insufficientData: true,
      };
    }

    const revenues = nonZeroMonths.map((m) => m.revenue);
    const n = revenues.length;

    if (method === 'exponential') {
      return this._predictExponential(revenues, n, periodCount);
    }
    return this._predictLinear(revenues, n, periodCount);
  }

  /**
   * 获取历史月度收入时间序列。
   */
  getHistoricalRevenue(tenantId?: string, months: number = 12): HistoricalRevenuePoint[] {
    return this._getHistoricalMonths(tenantId, months);
  }

  /**
   * 针对单个技能预测收入趋势。
   * 按 skillId 过滤计量记录，提取该技能的历史月度收入，再做预测。
   */
  predictBySkill(
    tenantId: string,
    skillId: string,
    periodCount: number = 3,
    method: 'linear' | 'exponential' = 'linear',
  ): ForecastResult {
    // 收集该技能的历史记录，按月份聚合
    const skillMonths = new Map<string, number>();
    const records = this.billingEngine.getAllMetering().filter(
      (r) => r.tenantId === tenantId && r.skillId === skillId && r.cost !== undefined,
    );
    for (const record of records) {
      const month = record.callAt.slice(0, 7); // yyyy-MM
      skillMonths.set(month, (skillMonths.get(month) ?? 0) + record.cost);
    }

    const revenues = Array.from(skillMonths.values());
    const n = revenues.length;

    if (n < ForecastService.MIN_DATA_POINTS) {
      return this._emptyResult(method, n);
    }

    if (method === 'exponential') {
      return this._predictExponential(revenues, n, periodCount);
    }
    return this._predictLinear(revenues, n, periodCount);
  }

  // ── 私有辅助 ──

  private _getHistoricalMonths(tenantId?: string, maxMonths: number): HistoricalRevenuePoint[] {
    // 生成最近 maxMonths 个月的账单摘要
    const now = new Date();
    const result: HistoricalRevenuePoint[] = [];

    for (let i = 0; i < maxMonths; i++) {
      // 使用更稳定的日期计算方式
      const year = now.getFullYear();
      const month = now.getMonth() - i;
      // 处理跨年情况
      const adjustedYear = month < 0 ? year + Math.floor(month / 12) : year;
      const adjustedMonth = ((month % 12) + 12) % 12;
      const period = `${adjustedYear}-${String(adjustedMonth + 1).padStart(2, '0')}`;

      let totalRevenue = 0;
      if (tenantId) {
        const bill = this.billingEngine.generateBill(tenantId, period);
        totalRevenue = bill.totalCost;
      } else {
        // 全平台：汇总所有租户
        totalRevenue = this._aggregatePlatformRevenue(period);
      }

      result.push({ month: period, revenue: totalRevenue });
    }

    // 按月份正序排列
    result.reverse();
    return result;
  }

  /**
   * 聚合全平台指定周期的收入（从所有租户的计量记录计算）。
   */
  private _aggregatePlatformRevenue(period: string): number {
    // 解析 period
    const [yearStr, monthStr] = period.split('-');
    const year = parseInt(yearStr, 10);
    const month = parseInt(monthStr, 10);
    const from = `${year}-${String(month).padStart(2, '0')}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const to = `${year}-${String(month).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

    const allRecords = this.billingEngine.getAllMetering();
    let total = 0;
    for (const record of allRecords) {
      if (record.callAt >= from && record.callAt <= to && record.cost) {
        total += record.cost;
      }
    }
    return total;
  }

  /**
   * 线性预测（最小二乘法）：y = a + b·x
   */
  private _predictLinear(revenues: number[], n: number, periodCount: number): ForecastResult {
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += revenues[i];
      sumXY += i * revenues[i];
      sumX2 += i * i;
    }
    const denominator = n * sumX2 - sumX * sumX;
    if (denominator === 0) {
      return this._emptyResult('linear', n);
    }
    const b = (n * sumXY - sumX * sumY) / denominator;
    const a = (sumY - b * sumX) / n;

    // 预测下一期
    const nextX = n; // x = n（第 n+1 个月）
    const predicted = a + b * nextX;
    const clampedPredicted = Math.max(0, predicted);

    // 趋势判断
    const trend = b > 0.01 ? 'up' : b < -0.01 ? 'down' : 'stable';

    // 残差标准差 → 置信区间
    let ssRes = 0;
    for (let i = 0; i < n; i++) {
      const fitted = a + b * i;
      ssRes += Math.pow(revenues[i] - fitted, 2);
    }
    const stdErr = n > 2 ? Math.sqrt(ssRes / (n - 2)) : 0;
    const margin = ForecastService.CONFIDENCE_FACTOR * stdErr;

    return {
      predictedRevenue: parseFloat(clampedPredicted.toFixed(6)),
      method: 'linear',
      trend,
      dataPoints: n,
      lowerBound: parseFloat(Math.max(0, clampedPredicted - margin).toFixed(6)),
      upperBound: parseFloat((clampedPredicted + margin).toFixed(6)),
      insufficientData: false,
    };
  }

  /**
   * 指数预测（对数线性化）：ln(y) = a + b·x
   * 过滤零值和负值后再做对数变换。
   */
  private _predictExponential(revenues: number[], n: number, periodCount: number): ForecastResult {
    // 过滤非正值，记录索引映射
    const validPairs: { x: number; logY: number }[] = [];
    for (let i = 0; i < n; i++) {
      if (revenues[i] > 0) {
        validPairs.push({ x: i, logY: Math.log(revenues[i]) });
      }
    }

    if (validPairs.length < ForecastService.MIN_DATA_POINTS) {
      return this._emptyResult('exponential', n);
    }

    const m = validPairs.length;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (const p of validPairs) {
      sumX += p.x;
      sumY += p.logY;
      sumXY += p.x * p.logY;
      sumX2 += p.x * p.x;
    }
    const denom = m * sumX2 - sumX * sumX;
    if (denom === 0) {
      return this._emptyResult('exponential', n);
    }
    const b = (m * sumXY - sumX * sumY) / denom;
    const a = (sumY - b * sumX) / m;

    const nextX = n;
    const predictedLog = a + b * nextX;
    const predicted = Math.max(0, Math.exp(predictedLog));

    const trend = b > 0.01 ? 'up' : b < -0.01 ? 'down' : 'stable';

    // 对数空间残差标准差
    let ssRes = 0;
    for (const p of validPairs) {
      const fitted = a + b * p.x;
      ssRes += Math.pow(p.logY - fitted, 2);
    }
    const stdErrLog = m > 2 ? Math.sqrt(ssRes / (m - 2)) : 0;
    // 指数转换置信区间：predicted × exp(±margin)
    const margin = ForecastService.CONFIDENCE_FACTOR * stdErrLog;
    const lowerBound = Math.max(0, predicted * Math.exp(-margin));
    const upperBound = predicted * Math.exp(margin);

    return {
      predictedRevenue: parseFloat(predicted.toFixed(6)),
      method: 'exponential',
      trend,
      dataPoints: n,
      lowerBound: parseFloat(lowerBound.toFixed(6)),
      upperBound: parseFloat(upperBound.toFixed(6)),
      insufficientData: false,
    };
  }

  private _emptyResult(method: 'linear' | 'exponential', dataPoints: number): ForecastResult {
    return {
      predictedRevenue: 0,
      method,
      trend: 'stable',
      dataPoints,
      lowerBound: 0,
      upperBound: 0,
      insufficientData: true,
    };
  }
}
