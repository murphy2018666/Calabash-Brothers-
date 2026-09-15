import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  MeteringRecord,
  CertificationRecord,
  UserRating,
  SkillRating,
  CallSuccessRate,
  QualitativeFlag,
  DelistWarning,
} from '@aegisci/shared/types';

/**
 * 技能评分引擎（K13-2）。
 *
 * 综合评分公式（MVP）：
 *   compositeScore = 0.4 × (userScoreAvg × 20) + 0.3 × (callSuccessRate × 100) + 0.3 × certificationBonus
 *   其中 userScoreAvg ∈ [1,5]，映射为 [20,100]
 *
 * 降权规则：
 *   stale      = lastCallAt > 180 days ago
 *   low_quality = compositeScore < 30
 *   both       = stale AND low_quality → 触发下架预警
 */
@Injectable()
export class SkillRatingService {
  private readonly logger = new Logger(SkillRatingService.name);

  /** 用户评分存储：tenantId/skillId → UserRating[] */
  private readonly ratingStore = new Map<string, UserRating[]>();
  /** 计量记录存储（用于计算成功率） */
  private readonly meteringStore = new Map<string, MeteringRecord>();
  /** 认证记录存储（用于计算认证加分） */
  private readonly certificationStore = new Map<string, CertificationRecord>();

  private static readonly STALE_DAYS = 180;
  private static readonly RATING_WINDOW_DAYS = 90;

  // ── 公共接口 ──

  /** 提交用户评分 */
  submitRating(tenantId: string, skillId: string, score: number, comment?: string): UserRating {
    if (score < 1 || score > 5) throw new Error('Score must be between 1 and 5');
    const now = new Date().toISOString();
    const record: UserRating = {
      ratingId: `rating-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      skillId,
      score,
      comment,
      createdAt: now,
    };
    const key = this._key(tenantId, skillId);
    const ratings = this.ratingStore.get(key) ?? [];
    ratings.push(record);
    this.ratingStore.set(key, ratings);
    this.logger.log(`Rating submitted: ${record.ratingId} skill=${skillId} score=${score}`);
    return record;
  }

  /** 记录一次调用（用于成功率计算） */
  recordCall(record: MeteringRecord): void {
    this.meteringStore.set(record.recordId, record);
  }

  /** 关联认证记录（用于认证加分计算） */
  linkCertification(skillId: string, certRecord: CertificationRecord): void {
    this.certificationStore.set(skillId, certRecord);
  }

  /** 查询技能的当前评分 */
  getRating(tenantId: string, skillId: string): SkillRating {
    const userScoreAvg = this._calcUserScoreAvg(tenantId, skillId);
    const callSuccessRate = this._calcCallSuccessRate(tenantId, skillId);
    const certificationBonus = this._calcCertificationBonus(skillId);
    const compositeScore = this._calcCompositeScore(userScoreAvg, callSuccessRate, certificationBonus);
    const tier = this._classifyTier(compositeScore);
    const { lastCallAt, qualitativeFlag } = this._qualitativeFlag(tenantId, skillId, compositeScore);

    return {
      skillId,
      tenantId,
      userScoreAvg,
      callSuccessRate,
      certificationBonus,
      compositeScore,
      tier,
      qualitativeFlag,
      lastCallAt,
      asOfDate: new Date().toISOString(),
    };
  }

  /** 批量查询 tenant 下所有技能的评分（分页） */
  listRatings(tenantId: string, page = 1, pageSize = 20): { ratings: SkillRating[]; total: number } {
    const allKeys = Array.from(this.ratingStore.keys()).filter((k) => k.startsWith(`${tenantId}:`));
    // 也包含只有计量但无用户评分的技能
    const meteredSkillIds = new Set(
      Array.from(this.meteringStore.values())
        .filter((r) => r.tenantId === tenantId)
        .map((r) => r.skillId),
    );
    const allSkillIds = new Set([...allKeys.map((k) => k.split(':')[1]), ...meteredSkillIds]);

    const ratings: SkillRating[] = Array.from(allSkillIds).map((skillId) =>
      this.getRating(tenantId, skillId),
    );

    // 按综合评分降序排序
    ratings.sort((a, b) => b.compositeScore - a.compositeScore);

    const total = ratings.length;
    const start = (page - 1) * pageSize;
    return { ratings: ratings.slice(start, start + pageSize), total };
  }

  /** 获取技能最近一次调用时间 */
  getLastCallAt(tenantId: string, skillId: string): string | undefined {
    const records = Array.from(this.meteringStore.values()).filter(
      (r) => r.tenantId === tenantId && r.skillId === skillId,
    );
    if (records.length === 0) return undefined;
    return records.reduce((latest, r) => (r.callAt > latest ? r.callAt : latest), records[0].callAt);
  }

  /** 清空存储（测试用） */
  clear(): void {
    this.ratingStore.clear();
    this.meteringStore.clear();
    this.certificationStore.clear();
  }

  // ── 私有辅助 ──

  private _key(tenantId: string, skillId: string): string {
    return `${tenantId}:${skillId}`;
  }

  /** 计算用户评分均值（最近 90 天） */
  private _calcUserScoreAvg(tenantId: string, skillId: string): number | null {
    const key = this._key(tenantId, skillId);
    const ratings = this.ratingStore.get(key) ?? [];
    const cutoff = new Date(Date.now() - SkillRatingService.RATING_WINDOW_DAYS * 86400000).toISOString();
    const recent = ratings.filter((r) => r.createdAt >= cutoff);
    if (recent.length === 0) return null;
    const avg = recent.reduce((s, r) => s + r.score, 0) / recent.length;
    return parseFloat(avg.toFixed(2));
  }

  /** 计算调用成功率（最近 90 天） */
  private _calcCallSuccessRate(tenantId: string, skillId: string): number {
    const records = Array.from(this.meteringStore.values()).filter(
      (r) => r.tenantId === tenantId && r.skillId === skillId && r.callAt >= this._cutoffISO(),
    );
    if (records.length === 0) return 1.0; // 无调用记录视为 100%
    // MVP 阶段：所有 metering 记录视为成功（success 由 cost > 0 隐含）
    const success = records.filter((r) => (r.cost ?? 0) > 0 || true).length;
    return parseFloat((success / records.length).toFixed(4));
  }

  /** 计算认证加分（0~15） */
  private _calcCertificationBonus(skillId: string): number {
    const cert = this.certificationStore.get(skillId);
    if (!cert || cert.status !== 'approved') return 0;
    if (new Date(cert.validUntil) < new Date()) return 0;
    return 15; // 有效认证 +15 分
  }

  /** 综合评分计算 */
  private _calcCompositeScore(
    userScoreAvg: number | null,
    callSuccessRate: number,
    certificationBonus: number,
  ): number {
    const userComponent = userScoreAvg !== null ? userScoreAvg * 20 : 40; // 默认中立值 50（平均分3×20=60，改40表示中性）
    const successComponent = callSuccessRate * 100;
    return parseFloat(
      (0.4 * userComponent + 0.3 * successComponent + 0.3 * certificationBonus).toFixed(2),
    );
  }

  /** 评分等级分类 */
  private _classifyTier(score: number): RatingTier {
    if (score >= 80) return 'excellent';
    if (score >= 60) return 'good';
    if (score >= 40) return 'average';
    return 'poor';
  }

  /** 定性标记：stale / low_quality / both / null */
  private _qualitativeFlag(tenantId: string, skillId: string, compositeScore: number): {
    lastCallAt?: string;
    qualitativeFlag: QualitativeFlag;
  } {
    const lastCallAt = this.getLastCallAt(tenantId, skillId);
    const isStale = !lastCallAt || new Date(lastCallAt) < new Date(Date.now() - SkillRatingService.STALE_DAYS * 86400000);
    const isLowQuality = compositeScore < 30;

    if (isStale && isLowQuality) return { lastCallAt, qualitativeFlag: 'both' as QualitativeFlag };
    if (isStale) return { lastCallAt, qualitativeFlag: 'stale' };
    if (isLowQuality) return { lastCallAt, qualitativeFlag: 'low_quality' };
    return { lastCallAt, qualitativeFlag: null };
  }

  private _cutoffISO(): string {
    return new Date(Date.now() - SkillRatingService.RATING_WINDOW_DAYS * 86400000).toISOString();
  }
}
