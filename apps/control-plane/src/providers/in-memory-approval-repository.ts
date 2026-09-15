import { Injectable, Logger } from '@nestjs/common';
import type { ApprovalTicketState, ApprovalTicketInit, ApprovalVote } from '@aegisci/domain/policy/approval';

/**
 * ApprovalRepositoryPort —— 审批工单持久化端口（F4）。
 *
 * 实现约定：
 * - save() 原子写入完整工单（含状态 + 投票）
 * - load(ticketId) 读取后重建（read-your-writes）
 * - listOpen() 返回所有 open 状态工单（供超时调度器轮询）
 */
export interface ApprovalRepositoryPort {
  save(ticket: ApprovalTicketSnapshot): Promise<void>;
  load(ticketId: string): Promise<ApprovalTicketSnapshot | null>;
  listOpen(tenantId: string): Promise<ApprovalTicketSnapshot[]>;
}

export interface ApprovalTicketSnapshot {
  ticketId: string;
  evidenceId: string;
  tenantId: string;
  requiredQuorum: number;
  state: ApprovalTicketState;
  votes: ApprovalVote[];
  createdAt: string;
}

/**
 * InMemoryApprovalRepository —— 内存审批工单存储（骨架/测试用）。
 */
@Injectable()
export class InMemoryApprovalRepository implements ApprovalRepositoryPort {
  private readonly tickets = new Map<string, ApprovalTicketSnapshot>();
  private readonly logger = new Logger(InMemoryApprovalRepository.name);

  async save(snapshot: ApprovalTicketSnapshot): Promise<void> {
    this.tickets.set(snapshot.ticketId, { ...snapshot, votes: [...snapshot.votes] });
    this.logger.debug(
      `saved ApprovalTicket ${snapshot.ticketId} (state=${snapshot.state})`,
    );
  }

  async load(ticketId: string): Promise<ApprovalTicketSnapshot | null> {
    const s = this.tickets.get(ticketId);
    return s ? { ...s, votes: [...s.votes] } : null;
  }

  async listOpen(): Promise<ApprovalTicketSnapshot[]> {
    return Array.from(this.tickets.values())
      .filter((s) => s.state === 'open')
      .map((s) => ({ ...s, votes: [...s.votes] }));
  }

  async clear(): Promise<void> {
    this.tickets.clear();
  }
}
