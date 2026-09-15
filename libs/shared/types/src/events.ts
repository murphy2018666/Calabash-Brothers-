/**
 * 技能市场领域事件类型定义（K17）。
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 技能下架/恢复事件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SkillDelistedEvent {
  eventType: 'skill.delisted';
  tenantId: string;
  skillId: string;
  workflowId: string;
  reason: string;
  delistedAt: string;
}

export interface SkillRestoredEvent {
  eventType: 'skill.restored';
  tenantId: string;
  skillId: string;
  workflowId: string;
  restoredAt: string;
  cancelledReason: string;
}

export type MarketEvent = SkillDelistedEvent | SkillRestoredEvent;
