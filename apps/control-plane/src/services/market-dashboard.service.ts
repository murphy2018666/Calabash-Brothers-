import { Injectable, Logger } from '@nestjs/common';
import {
  MeteringRecord,
  MonthlyBill,
  SplitRecord,
  Settlement,
  SettlementStats,
  SkillRating,
  DelistWarning,
  CertificationRecord,
} from '@aegisci/shared/types';
import { BillingEngineService } from './billing-engine.service';
import { SettlementService } from './settlement-service';
import { SkillRatingService } from './skill-rating.service';
import { DelistWarningService } from './delist-warning.service';
import { CertificationEngineService } from './certification-engine.service';
import { ForecastService, type ForecastResult } from './forecast.service';
import { AutoRenewalService, type AutoRenewalConfig } from './auto-renewal.service';

/**
 * 收入汇总
 */
export interface RevenueSummary {
  totalRevenue: number;
  monthlyTrend: { month: string; revenue: number }[];
  topSkills: { skillId: string; revenue: number }[];
}

/**
 * 评分分布
 */
export interface RatingMetrics {
  avgScore: number | null;
  excellentCount: number;
  goodCount: number;
  averageCount: number;
  poorCount: number;
}

/**
 * 预警统计
 */
export interface WarningMetrics {
  staleCount: number;
  lowQualityCount: number;
  totalWarnings: number;
  resolvedWarnings: number;
}

/**
 * 认证统计
 */
export interface CertificationStats {
  total: number;
  approved: number;
  pending: number;
  suspended: number;
}

/**
 * 完整仪表板数据
 */
export interface MarketDashboard {
  tenantId: string;
  asOfDate: string;
  healthScore: number;
  skillCount: number;
  activeSkillCount: number;
  certifiedSkillCount: number;
  revenueMetrics: RevenueSummary;
  ratingMetrics: RatingMetrics;
  warningMetrics: WarningMetrics;
  certificationStats: CertificationStats;
  /** 收入预测（K16-3） */
  forecast: ForecastResult;
}

/**
 * 平台汇总数据（K15-4：多租户隔离仪表板）
 */
export interface PlatformOverview {
  asOfDate: string;
  totalTenants: number;
  totalSkills: number;
  totalActiveSkills: number;
  totalCertifiedSkills: number;
  totalRevenue: number;
  avgHealthScore: number;
  totalWarnings: number;
  totalApprovals: number;
}

/**
 * 市场运营仪表板服务（K14/K15）。
 *
 * 聚合 K10/K11/K12/K13 多源数据，输出健康度全景视图。
 * 支持租户级和平台级汇总视图。
 */
@Injectable()
export class MarketDashboardService {
  private readonly logger = new Logger(MarketDashboardService.name);

  constructor(
    private readonly billingEngine: BillingEngineService,
    private readonly settlementService: SettlementService,
    private readonly skillRating: SkillRatingService,
    private readonly delistWarning: DelistWarningService,
    private readonly certificationEngine: CertificationEngineService,
    private readonly forecastService: ForecastService,
    private readonly autoRenewalService: AutoRenewalService,
  ) {}

  // ── 公共接口 ──

  /** 获取完整仪表板 */
  getCompositeDashboard(tenantId: string): MarketDashboard {
    const now = new Date().toISOString();
    return {
      tenantId,
      asOfDate: now,
      healthScore: this._calcHealthScore(tenantId),
      skillCount: this._countSkills(tenantId),
      activeSkillCount: this._countActiveSkills(tenantId),
      certifiedSkillCount: this._countCertifiedSkills(tenantId),
      revenueMetrics: this._getRevenueSummary(tenantId),
      ratingMetrics: this._getRatingMetrics(tenantId),
      warningMetrics: this._getWarningMetrics(tenantId),
      certificationStats: this._getCertificationStats(tenantId),
      forecast: this.forecastService.predict(tenantId, 3, 'linear'),
    };
  }

  /** 获取技能健康度评分 */
  getHealthScore(tenantId: string): { overall: number; skills: Record<string, number> } {
    const skills = this._getAllSkillRatings(tenantId);
    const skillScores: Record<string, number> = {};
    let total = 0;
    for (const [skillId, rating] of skills) {
      skillScores[skillId] = rating.compositeScore;
      total += rating.compositeScore;
    }
    const overall = skills.size > 0 ? parseFloat((total / skills.size).toFixed(2)) : 0;
    return { overall, skills: skillScores };
  }

  /** 获取收入汇总 */
  getRevenueSummary(tenantId: string, period?: string): RevenueSummary {
    return this._getRevenueSummary(tenantId, period);
  }

  /** 获取预警统计 */
  getWarningStats(tenantId: string): WarningMetrics {
    return this._getWarningMetrics(tenantId);
  }

  /** 获取认证统计 */
  getCertificationStats(tenantId: string): CertificationStats {
    return this._getCertificationStats(tenantId);
  }

  /** 获取续约提醒（K20-4） */
  getRenewalReminders(tenantId: string, hoursAhead: number = 24): AutoRenewalConfig[] {
    return this.autoRenewalService.getUpcomingRenewals(tenantId, hoursAhead);
  }

  /** 获取单租户概要 */
  getTenantSummary(tenantId: string): {
    skillCount: number;
    totalRevenue: number;
    avgHealthScore: number;
    certifiedCount: number;
    warningCount: number;
  } {
    const dashboard = this.getCompositeDashboard(tenantId);
    const revenue = this._getRevenueSummary(tenantId);
    const health = this.getHealthScore(tenantId);
    return {
      skillCount: dashboard.skillCount,
      totalRevenue: revenue.totalRevenue,
      avgHealthScore: health.overall,
      certifiedCount: dashboard.certifiedSkillCount,
      warningCount: dashboard.warningMetrics.totalWarnings,
    };
  }

  /** 获取全平台汇总（K15-4） */
  getPlatformOverview(): PlatformOverview {
    const now = new Date().toISOString();

    // 收集所有租户 ID
    const allMetering = this.billingEngine.getAllMetering();
    const allSettlements = this.settlementService.getAllSettlements();
    const allWarnings = this.delistWarning.listWarnings();

    const tenantIds = new Set([
      ...allMetering.map((r) => r.tenantId),
      ...allSettlements.map((s) => s.tenantId),
    ]);

    let totalRevenue = 0;
    let totalHealthScore = 0;
    let totalSkills = 0;
    let totalActiveSkills = 0;
    let totalCertifiedSkills = 0;
    let totalWarnings = 0;
    let totalApproved = 0;

    for (const tenantId of tenantIds) {
      const dashboard = this.getCompositeDashboard(tenantId);
      const revenue = this._getRevenueSummary(tenantId);
      totalRevenue += revenue.totalRevenue;
      totalHealthScore += dashboard.healthScore;
      totalSkills += dashboard.skillCount;
      totalActiveSkills += dashboard.activeSkillCount;
      totalCertifiedSkills += dashboard.certifiedSkillCount;
      totalWarnings += dashboard.warningMetrics.totalWarnings;
      totalApproved += dashboard.certificationStats.approved;
    }

    const avgHealthScore = tenantIds.size > 0
      ? parseFloat((totalHealthScore / tenantIds.size).toFixed(2))
      : 0;

    return {
      asOfDate: now,
      totalTenants: tenantIds.size,
      totalSkills,
      totalActiveSkills,
      totalCertifiedSkills,
      totalRevenue: parseFloat(totalRevenue.toFixed(6)),
      avgHealthScore,
      totalWarnings,
      totalApprovals: totalApproved,
      platformForecast: this.forecastService.predict(undefined, 3, 'linear'),
    };
  }

  /** 刷新缓存（测试用） */
  clear(): void {
    // 依赖的服务各自有 clear()
  }

  // ── 私有辅助 ──

  private _getAllSkillRatings(tenantId: string): Map<string, SkillRating> {
    const result = this.skillRating.listRatings(tenantId);
    const map = new Map<string, SkillRating>();
    for (const rating of result.ratings) {
      map.set(rating.skillId, rating);
    }
    return map;
  }

  /** 计算综合健康度（0-100） */
  private _calcHealthScore(tenantId: string): number {
    const skills = this._getAllSkillRatings(tenantId);
    if (skills.size === 0) return 0;

    let totalScore = 0;
    for (const rating of skills.values()) {
      totalScore += rating.compositeScore;
    }
    const avgScore = totalScore / skills.size;

    // 健康度 = 平均评分 × 认证覆盖率 × 预警惩罚系数
    const certifiedCount = this._countCertifiedSkills(tenantId);
    const certificationRate = skills.size > 0 ? certifiedCount / skills.size : 0;
    const warningMetrics = this._getWarningMetrics(tenantId);
    const warningPenalty = Math.max(0, 1 - warningMetrics.totalWarnings / Math.max(skills.size, 1));

    return parseFloat((avgScore * (0.5 + 0.5 * certificationRate) * warningPenalty).toFixed(2));
  }

  /** 技能总数 */
  private _countSkills(tenantId: string): number {
    return this._getAllSkillRatings(tenantId).size;
  }

  /** 活跃技能数（有调用记录） */
  private _countActiveSkills(tenantId: string): number {
    const stats = this.billingEngine.getStats(tenantId);
    return stats.totalCalls > 0 ? this._getAllSkillRatings(tenantId).size : 0;
  }

  /** 认证技能数 */
  private _countCertifiedSkills(tenantId: string): number {
    const records = this.certificationEngine.listCertifications({ tenantId });
    return records.records.filter((r) => r.status === 'approved').length;
  }

  /** 收入汇总 */
  private _getRevenueSummary(tenantId: string, period?: string): RevenueSummary {
    // 从结算数据计算收入
    const settlementQuery = { tenantId, page: 1, pageSize: 100 };
    const settlements = this.settlementService.listSettlements(settlementQuery);

    // 汇总收入
    const totalRevenue = settlements.settlements.reduce((sum, s) => sum + s.totalRevenue, 0);

    // 月度趋势（近 6 个月）
    const monthlyMap = new Map<string, number>();
    for (const settlement of settlements.settlements) {
      const month = settlement.period ?? 'unknown';
      monthlyMap.set(month, (monthlyMap.get(month) ?? 0) + settlement.totalRevenue);
    }
    const monthlyTrend = Array.from(monthlyMap.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .slice(-6)
      .map(([month, revenue]) => ({ month, revenue }));

    // Top 技能排行
    const skillRevenue = new Map<string, number>();
    for (const settlement of settlements.settlements) {
      for (const split of settlement.splitRecords) {
        skillRevenue.set(split.skillId, (skillRevenue.get(split.skillId) ?? 0) + split.skillOwnerAmount);
      }
    }
    const topSkills = Array.from(skillRevenue.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([skillId, revenue]) => ({ skillId, revenue }));

    return { totalRevenue, monthlyTrend, topSkills };
  }

  /** 评分分布 */
  private _getRatingMetrics(tenantId: string): RatingMetrics {
    const skills = this._getAllSkillRatings(tenantId);
    if (skills.size === 0) {
      return { avgScore: null, excellentCount: 0, goodCount: 0, averageCount: 0, poorCount: 0 };
    }

    let totalScore = 0;
    let excellentCount = 0, goodCount = 0, averageCount = 0, poorCount = 0;
    for (const rating of skills.values()) {
      totalScore += rating.compositeScore;
      if (rating.tier === 'excellent') excellentCount++;
      else if (rating.tier === 'good') goodCount++;
      else if (rating.tier === 'average') averageCount++;
      else poorCount++;
    }

    return {
      avgScore: parseFloat((totalScore / skills.size).toFixed(2)),
      excellentCount,
      goodCount,
      averageCount,
      poorCount,
    };
  }

  /** 预警统计 */
  private _getWarningMetrics(tenantId: string): WarningMetrics {
    const warnings = this.delistWarning.listWarnings(tenantId);
    let stale = 0, lowQuality = 0;
    for (const w of warnings) {
      if (w.reason === 'stale' || w.reason === 'both') stale++;
      if (w.reason === 'low_quality' || w.reason === 'both') lowQuality++;
    }
    return {
      staleCount: stale,
      lowQualityCount: lowQuality,
      totalWarnings: warnings.length,
      resolvedWarnings: 0,
    };
  }

  /** 认证统计 */
  private _getCertificationStats(tenantId: string): CertificationStats {
    const records = this.certificationEngine.listCertifications({ tenantId });
    let total = 0, approved = 0, pending = 0, suspended = 0;
    for (const r of records.records) {
      total++;
      if (r.status === 'approved') approved++;
      else if (r.status === 'pending') pending++;
      else if (r.status === 'suspended') suspended++;
    }
    return { total, approved, pending, suspended };
  }
}
