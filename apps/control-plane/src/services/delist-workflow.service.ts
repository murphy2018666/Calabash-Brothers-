import { Injectable, Logger } from '@nestjs/common';
import { DelistWarningService } from './delist-warning.service';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SkillDelistedEvent, SkillRestoredEvent } from '@aegisci/shared/types';

export type WorkflowStatus = 'pending' | 'notification_sent' | 'appealed' | 'delisted' | 'cancelled';

export interface DelistWorkflow {
  workflowId: string;
  tenantId: string;
  skillId: string;
  reason: string;
  status: WorkflowStatus;
  createdAt: string;
  notificationSentAt?: string;
  delistedAt?: string;
  cancelledAt?: string;
  cancelledReason?: string;
}

/**
 * 自动下架工作流服务（K17）。
 *
 * 状态机：
 *   pending → notification_sent → delisted
 *                              → cancelled
 */
@Injectable()
export class DelistWorkflowService {
  private readonly logger = new Logger(DelistWorkflowService.name);

  /** 通知后等待申诉窗口期（天） */
  private static readonly APPEAL_WINDOW_DAYS = 7;

  private readonly workflows = new Map<string, DelistWorkflow>();

  constructor(
    private readonly delistWarningService: DelistWarningService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * 创建下架工作流（幂等：同一 skillId 已有 active 工作流时返回已有实例）。
   */
  startWorkflow(tenantId: string, skillId: string, reason: string): DelistWorkflow {
    const existing = this.findActiveWorkflow(tenantId, skillId);
    if (existing) {
      try { this.logger.warn(`duplicate startWorkflow ignored: workflow ${existing.workflowId} already active`); } catch {}
      return existing;
    }

    const workflow: DelistWorkflow = {
      workflowId: `wf-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      skillId,
      reason,
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.workflows.set(workflow.workflowId, workflow);
    try { this.logger.info(`workflow started: ${workflow.workflowId} skill=${skillId} reason=${reason}`); } catch {}
    return workflow;
  }

  /**
   * 发送下架通知给技能所有者。
   */
  notifySkillOwner(tenantId: string, skillId: string): DelistWorkflow | null {
    const workflow = this._findActive(tenantId, skillId);
    if (!workflow) return null;
    if (workflow.status !== 'pending') return workflow;

    workflow.status = 'notification_sent';
    workflow.notificationSentAt = new Date().toISOString();
    this.workflows.set(workflow.workflowId, workflow);
    try { this.logger.info(`notification sent: ${workflow.workflowId} skill=${skillId}`); } catch {}
    return workflow;
  }

  /**
   * 执行下架操作。
   */
  execDelist(tenantId: string, skillId: string): DelistWorkflow | null {
    const workflow = this._findActive(tenantId, skillId);
    if (!workflow) return null;
    if (workflow.status !== 'notification_sent') {
      try { this.logger.warn(`execDelist blocked: workflow ${workflow.workflowId} status=${workflow.status}`); } catch {}
      return workflow;
    }

    workflow.status = 'delisted';
    workflow.delistedAt = new Date().toISOString();
    this.workflows.set(workflow.workflowId, workflow);
    try { this.logger.info(`skill delisted: ${workflow.workflowId} skill=${skillId}`); } catch {}
    this._publishDelistedEvent(workflow);
    return workflow;
  }

  /**
   * 撤销下架（申诉成功）。
   */
  cancelWorkflow(tenantId: string, workflowId: string, reason?: string): DelistWorkflow | null {
    const workflow = this.workflows.get(workflowId);
    if (!workflow || workflow.tenantId !== tenantId) return null;
    if (workflow.status !== 'notification_sent' && workflow.status !== 'pending') {
      return workflow;
    }

    workflow.status = 'cancelled';
    workflow.cancelledAt = new Date().toISOString();
    workflow.cancelledReason = reason ?? 'appeal_accepted';
    this.workflows.set(workflowId, workflow);
    try { this.logger.info(`workflow cancelled: ${workflowId} reason=${workflow.cancelledReason}`); } catch {}
    this._publishRestoredEvent(workflow);
    return workflow;
  }

  /**
   * 查询工作流列表。
   */
  listWorkflows(tenantId?: string, status?: WorkflowStatus): DelistWorkflow[] {
    let results = Array.from(this.workflows.values());
    if (tenantId) {
      results = results.filter((w) => w.tenantId === tenantId);
    }
    if (status) {
      results = results.filter((w) => w.status === status);
    }
    return results;
  }

  /**
   * 触发自动下架：当 delist warning 级别达到 critical 且无 active 工作流时自动创建。
   */
  triggerAutoDelist(tenantId?: string): DelistWorkflow[] {
    const warnings = this.delistWarningService.listWarnings(tenantId);
    const created: DelistWorkflow[] = [];
    for (const warning of warnings) {
      if (warning.compositeScore >= 20) continue;
      const existing = this.findActiveWorkflow(warning.tenantId, warning.skillId);
      if (existing) continue;
      const wf = this.startWorkflow(warning.tenantId, warning.skillId, warning.reason);
      this.notifySkillOwner(warning.tenantId, warning.skillId);
      created.push(wf);
    }
    return created;
  }

  /** 测试用清空 */
  clear(): void {
    this.workflows.clear();
  }

  // ── 私有辅助 ──

  private _findActive(tenantId: string, skillId: string): DelistWorkflow | null {
    for (const w of this.workflows.values()) {
      if (w.tenantId === tenantId && w.skillId === skillId && w.status !== 'delisted' && w.status !== 'cancelled') {
        return w;
      }
    }
    return null;
  }

  findActiveWorkflow(tenantId: string, skillId: string): DelistWorkflow | null {
    return this._findActive(tenantId, skillId);
  }

  /** 发布下架事件（K17-2） */
  private _publishDelistedEvent(wf: DelistWorkflow): void {
    try {
      const event: SkillDelistedEvent = {
        eventType: 'skill.delisted',
        tenantId: wf.tenantId,
        skillId: wf.skillId,
        workflowId: wf.workflowId,
        reason: wf.reason,
        delistedAt: wf.delistedAt!,
      };
      this.eventEmitter.emit('market.event', event);
    } catch (e) {
      // 事件发布失败不影响主流程
      try { this.logger.warn(`failed to publish delisted event: ${(e as Error).message}`); } catch {}
    }
  }

  /** 发布恢复事件（K17-2） */
  private _publishRestoredEvent(wf: DelistWorkflow): void {
    try {
      const event: SkillRestoredEvent = {
        eventType: 'skill.restored',
        tenantId: wf.tenantId,
        skillId: wf.skillId,
        workflowId: wf.workflowId,
        restoredAt: wf.cancelledAt!,
        cancelledReason: wf.cancelledReason ?? 'appeal_accepted',
      };
      this.eventEmitter.emit('market.event', event);
    } catch (e) {
      try { this.logger.warn(`failed to publish restored event: ${(e as Error).message}`); } catch {}
    }
  }
}
