/**
 * 技能市场质量治理类型定义（K13，V2.0 技能市场质量子域）。
 *
 * 评分聚合公式（MVP）：
 *   综合评分 = 0.4 × 用户评分均值 + 0.3 × 调用成功率×100 + 0.3 × 认证加分(0-15)
 *
 * 降权规则：
 *   stale（>180天无新调用）
 *   low_quality（综合评分 < 30）
 *   两者同时满足 → 触发下架预警
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 评分等级
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type RatingTier = 'excellent' | 'good' | 'average' | 'poor';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 用户评分记录
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface UserRating {
  ratingId: string;
  tenantId: string;
  skillId: string;
  score: number; // 1~5
  comment?: string;
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 调用成功率记录（来自 Metering）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface CallSuccessRate {
  /** 过去 N 天的总调用次数 */
  totalCalls: number;
  /** 成功调用次数 */
  successCalls: number;
  /** 成功率 (0~1) */
  successRate: number;
  /** 统计周期结束时间 */
  periodEnd: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 技能综合评分
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type QualitativeFlag = 'stale' | 'low_quality' | null;

export interface SkillRating {
  skillId: string;
  tenantId: string;
  /** 用户评分均值（1~5），null 表示尚无评分 */
  userScoreAvg: number | null;
  /** 调用成功率（0~1） */
  callSuccessRate: number;
  /** 认证加分（0~15），未认证为 0 */
  certificationBonus: number;
  /** 综合评分（0~100） */
  compositeScore: number;
  /** 评分等级 */
  tier: RatingTier;
  /** 定性标记 */
  qualitativeFlag: QualitativeFlag;
  /** 最近一次调用时间（用于判断 stale） */
  lastCallAt?: string;
  /** 统计截止日期 */
  asOfDate: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 下架预警事件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface DelistWarning {
  warningId: string;
  skillId: string;
  tenantId: string;
  /** 触发原因：'stale' | 'low_quality' | 'both' */
  reason: 'stale' | 'low_quality' | 'both';
  /** 当前综合评分 */
  compositeScore: number;
  /** 预警生成时间 */
  generatedAt: string;
}
