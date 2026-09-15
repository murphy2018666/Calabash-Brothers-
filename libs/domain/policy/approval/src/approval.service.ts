import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DomainEvent } from '@aegisci/shared/types';
import { ApprovalTicket, type ApprovalVote } from './approval-ticket.aggregate';

/**
 * ApprovalCompleted 事件载荷 —— 跨子域契约（流向 Credential）。
 * Credential 子域按此结构消费，不反向依赖 Approval（目录即边界）。
 */
export interface ApprovalCompletedPayload {
  readonly ticketId: string;
  /** Credential 仅消费 evidenceId，不复算裁决（DES-5.0 约束 3）。 */
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly approvedBy: string[];
  readonly quorum: number;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

/**
 * Approval 子域服务 —— HITL 审批工作流（DES-5.0 冷路径）。
 *
 * 不变式：
 * - 不持有出站通道：仅发布 ApprovalRequested / ApprovalCompleted / ApprovalRejected 领域事件。
 * - ApprovalCompleted 是流向 Credential 子域的唯一事件。
 * - 持久化目标：PG policy_approval_*（骨架阶段内存暂存）。
 */
@Injectable()
export class ApprovalService {
  private readonly logger = new Logger(ApprovalService.name);
  private readonly tickets = new Map<string, ApprovalTicket>();

  constructor(private readonly events: EventEmitter2) {}

  /**
   * 创建审批工单 —— 由 Decision HALLOW 裁决触发（经编排/事件调用，非裁决同步回流）。
   * 发布 ApprovalRequested 供平台出站适配器订阅投递站内/Webhook/邮件。
   */
  async createTicket(
    evidenceId: string,
    tenantId: string,
    requiredQuorum: number,
  ): Promise<ApprovalTicket> {
    const ticket = new ApprovalTicket({
      ticketId: randomUUID(),
      evidenceId,
      tenantId,
      requiredQuorum,
      freshnessLimitMs: FIFTEEN_MIN_MS,
      createdAt: new Date().toISOString(),
    });
    this.tickets.set(ticket.ticketId, ticket);
    this.logger.debug(`created approval ticket ${ticket.ticketId} (quorum=${requiredQuorum})`);
    this.events.emit(
      'ApprovalRequested',
      this.toEvent('ApprovalRequested', ticket, {
        ticketId: ticket.ticketId,
        evidenceId: ticket.evidenceId,
        tenantId: ticket.tenantId,
        requiredQuorum: ticket.requiredQuorum,
      }),
    );
    return ticket;
  }

  /** 记录投票 —— quorum 达成时发布 ApprovalCompleted。 */
  async castVote(
    ticketId: string,
    vote: Omit<ApprovalVote, 'timestamp'>,
  ): Promise<ApprovalTicket> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      throw new Error(`approval ticket not found: ${ticketId}`);
    }
    ticket.castVote({ ...vote, timestamp: new Date().toISOString() });
    if (ticket.state === 'approved') {
      this.events.emit('ApprovalCompleted', this.completedEvent(ticket));
    } else if (ticket.state === 'rejected' || ticket.state === 'timeout') {
      this.events.emit(
        'ApprovalRejected',
        this.toEvent('ApprovalRejected', ticket, { state: ticket.state }),
      );
    }
    return ticket;
  }

  /** 超时关闭 —— 调度器周期调用，新鲜度窗口外自动拒绝。 */
  async timeoutExpired(ticketId: string): Promise<void> {
    const ticket = this.tickets.get(ticketId);
    if (!ticket) {
      return;
    }
    ticket.timeout();
    this.events.emit(
      'ApprovalRejected',
      this.toEvent('ApprovalRejected', ticket, { state: 'timeout' }),
    );
  }

  async getTicket(ticketId: string): Promise<ApprovalTicket | null> {
    return this.tickets.get(ticketId) ?? null;
  }

  private completedEvent(ticket: ApprovalTicket): DomainEvent<ApprovalCompletedPayload> {
    return {
      eventId: randomUUID(),
      eventType: 'ApprovalCompleted',
      aggregateId: ticket.ticketId,
      aggregateType: 'ApprovalTicket',
      tenantId: ticket.tenantId,
      payload: {
        ticketId: ticket.ticketId,
        evidenceId: ticket.evidenceId,
        tenantId: ticket.tenantId,
        approvedBy: ticket.approvedBy,
        quorum: ticket.requiredQuorum,
      },
      timestamp: new Date().toISOString(),
      traceId: '',
      spanId: '',
    };
  }

  private toEvent<T>(
    eventType: string,
    ticket: ApprovalTicket,
    payload: T,
  ): DomainEvent<T> {
    return {
      eventId: randomUUID(),
      eventType,
      aggregateId: ticket.ticketId,
      aggregateType: 'ApprovalTicket',
      tenantId: ticket.tenantId,
      payload,
      timestamp: new Date().toISOString(),
      traceId: '',
      spanId: '',
    };
  }
}
