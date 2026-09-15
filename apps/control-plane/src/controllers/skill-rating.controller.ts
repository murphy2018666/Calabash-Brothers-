import { Controller, Get, Post, Param, Query } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SkillRatingService } from '../services/skill-rating.service';
import { DelistWarningService } from '../services/delist-warning.service';
import { type MeteringRecord } from '@aegisci/shared/types';

/**
 * 技能评分控制器（K13-4）。
 *
 * 端点：
 *   POST   /api/ratings                    — 提交用户评分
 *   GET    /api/ratings/:skillId           — 查询单个技能评分
 *   GET    /api/ratings                   — 批量评分列表
 *   POST   /api/ratings/meter              — 记录计量（触发重新评分）
 *   GET    /api/delist-warnings            — 下架预警列表
 *   POST   /api/delist-warnings/:id/ack    — 确认并清除预警
 */
@Controller('api')
export class SkillRatingController {
  constructor(
    private readonly skillRating: SkillRatingService,
    private readonly delistWarning: DelistWarningService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Post('ratings')
  submitRating(
    @Query('tenantId') tenantId: string,
    @Query('skillId') skillId: string,
    @Query('score') score: string,
    @Query('comment') comment?: string,
  ) {
    const record = this.skillRating.submitRating(tenantId, skillId, parseInt(score), comment);
    // 评分更新后触发重新计算并广播事件
    this._emitRatingUpdate(tenantId, skillId);
    return record;
  }

  @Get('ratings/:skillId')
  getRating(@Param('skillId') skillId: string, @Query('tenantId') tenantId: string) {
    return this.skillRating.getRating(tenantId, skillId);
  }

  @Get('ratings')
  listRatings(@Query('tenantId') tenantId: string, @Query('page') page?: string, @Query('pageSize') pageSize?: string) {
    return this.skillRating.listRatings(tenantId, parseInt(page ?? '1'), parseInt(pageSize ?? '20'));
  }

  @Post('ratings/meter')
  recordMetering(@Query() body: Record<string, string>) {
    const record: MeteringRecord = {
      recordId: body.recordId ?? `meter-${Date.now()}`,
      tenantId: body.tenantId,
      skillId: body.skillId,
      callAt: body.callAt ?? new Date().toISOString(),
      durationMs: parseInt(body.durationMs ?? '0'),
      usageType: body.usageType ?? 'tool',
      evidenceId: body.evidenceId ?? `ev-${Date.now()}`,
      traceSpanId: body.traceSpanId ?? `span-${Date.now()}`,
    };
    this.skillRating.recordCall(record);
    this._emitRatingUpdate(record.tenantId, record.skillId);
    return { acknowledged: true };
  }

  @Get('delist-warnings')
  listWarnings(@Query('tenantId') tenantId?: string) {
    return this.delistWarning.listWarnings(tenantId);
  }

  @Post('delist-warnings/:id/ack')
  acknowledgeWarning(@Param('id') warningId: string) {
    const ok = this.delistWarning.acknowledgeWarning(warningId);
    if (!ok) throw new Error(`Warning not found: ${warningId}`);
    return { acknowledged: true };
  }

  // ── 私有辅助 ──

  private _emitRatingUpdate(tenantId: string, skillId: string) {
    try {
      const rating = this.skillRating.getRating(tenantId, skillId);
      this.eventEmitter.emit('skill.rating.updated', { skillId, tenantId, rating });
    } catch {
      // 忽略事件广播错误
    }
  }
}
