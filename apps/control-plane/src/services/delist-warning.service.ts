import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { SkillRating, DelistWarning } from '@aegisci/shared/types';

/**
 * 下架预警服务（K13-3）。
 *
 * 监听 SkillRatingService 的评分更新事件，
 * 当检测到 stale+low_quality（both）时生成下架预警。
 */
@Injectable()
export class DelistWarningService {
  private readonly logger = new Logger(DelistWarningService.name);

  private readonly warningStore = new Map<string, DelistWarning>();

  /** 处理评分更新事件，生成预警 */
  @OnEvent('skill.rating.updated')
  handleRatingUpdate(payload: { skillId: string; tenantId: string; rating: SkillRating }) {
    const { skillId, tenantId, rating } = payload;
    if (rating.qualitativeFlag !== 'both') return;

    const warning: DelistWarning = {
      warningId: `warning-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      skillId,
      tenantId,
      reason: 'both',
      compositeScore: rating.compositeScore,
      generatedAt: new Date().toISOString(),
    };
    this.warningStore.set(warning.warningId, warning);
    this.logger.warn(
      `Delist warning generated: ${warning.warningId} skill=${skillId} score=${rating.compositeScore}`,
    );
  }

  /** 查询预警列表 */
  listWarnings(tenantId?: string): DelistWarning[] {
    if (!tenantId) return Array.from(this.warningStore.values());
    return Array.from(this.warningStore.values()).filter((w) => w.tenantId === tenantId);
  }

  /** 确认并清除预警 */
  acknowledgeWarning(warningId: string): boolean {
    if (!this.warningStore.has(warningId)) return false;
    this.warningStore.delete(warningId);
    return true;
  }

  /** 清空存储（测试用） */
  clear(): void {
    this.warningStore.clear();
  }
}
