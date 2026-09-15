/**
 * Approval 子域 —— 审批工单聚合根 + quorum 计票（DES-5.0 冷路径）。
 *
 * 域内交互约束：
 * - Approval 不持有出站通道：工单创建/完成仅发布领域事件，由平台出站适配器（NTF）订阅投递。
 * - Approval → Credential 仅经 ApprovalCompleted 事件（DES-6.2 时序一致）。
 * - 超时自动拒绝（FR-M3-05）；工单新鲜度 ≤ 15min。
 * - 存储前缀 policy_approval_*，禁止跨子域 JOIN。
 */

export type ApprovalTicketState = 'open' | 'approved' | 'rejected' | 'timeout';

export interface ApprovalVote {
  readonly voterId: string;
  readonly voterType: 'user';
  readonly decision: 'approve' | 'reject';
  readonly reason: string;
  readonly timestamp: string;
}

export interface ApprovalTicketInit {
  readonly ticketId: string;
  /** 关联 Decision 裁决证据（仅持有 evidenceId，不持有裁决对象）。 */
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly requiredQuorum: number;
  /** 新鲜度窗口（毫秒），默认 15min。 */
  readonly freshnessLimitMs?: number;
  readonly createdAt: string;
}

const FIFTEEN_MIN_MS = 15 * 60 * 1000;

export class ApprovalTicket {
  readonly ticketId: string;
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly requiredQuorum: number;
  readonly freshnessLimitMs: number;
  readonly createdAt: string;
  private readonly _votes: ApprovalVote[] = [];
  private _state: ApprovalTicketState = 'open';

  constructor(init: ApprovalTicketInit) {
    this.ticketId = init.ticketId;
    this.evidenceId = init.evidenceId;
    this.tenantId = init.tenantId;
    this.requiredQuorum = init.requiredQuorum;
    this.freshnessLimitMs = init.freshnessLimitMs ?? FIFTEEN_MIN_MS;
    this.createdAt = init.createdAt;
  }

  get state(): ApprovalTicketState {
    return this._state;
  }

  get votes(): readonly ApprovalVote[] {
    return this._votes;
  }

  /** 工单是否仍在新鲜度窗口内（≤15min）。 */
  get isFresh(): boolean {
    return Date.now() - new Date(this.createdAt).getTime() <= this.freshnessLimitMs;
  }

  get approveCount(): number {
    return this._votes.filter((v) => v.decision === 'approve').length;
  }

  get rejectCount(): number {
    return this._votes.filter((v) => v.decision === 'reject').length;
  }

  get quorumMet(): boolean {
    return this.approveCount >= this.requiredQuorum;
  }

  get approvedBy(): string[] {
    return this._votes.filter((v) => v.decision === 'approve').map((v) => v.voterId);
  }

  /** 投票 —— 工单超时/已结束时拒绝写入。 */
  castVote(vote: ApprovalVote): void {
    if (this._state !== 'open') {
      throw new Error(`ticket ${this.ticketId} not open (state=${this._state})`);
    }
    if (!this.isFresh) {
      this._state = 'timeout';
      throw new Error(`ticket ${this.ticketId} expired`);
    }
    if (this._votes.some((v) => v.voterId === vote.voterId)) {
      throw new Error(`voter ${vote.voterId} already voted on ${this.ticketId}`);
    }
    this._votes.push(vote);
    if (vote.decision === 'reject' && this.rejectCount >= this.requiredQuorum) {
      this._state = 'rejected';
    } else if (this.quorumMet) {
      this._state = 'approved';
    }
  }

  /** 超时关闭 —— 调度器调用，新鲜度窗口外自动拒绝。 */
  timeout(): void {
    if (this._state === 'open') {
      this._state = 'timeout';
    }
  }
}
