/**
 * Gate 聚合根（PL 域）
 *
 * 对应设计文档：
 * - DES-3 PL 限界上下文：聚合根 Gate（门禁裁决所有方）
 * - ADD §3.2 铁律 2：Gate 归 PL，裁决发起归 OR
 *   OR 收集 Agent 结论生成 riskSummary → 发 RiskSummaryReady；
 *   PL 持有 Gate 聚合根、判定门禁类型（自动/HITL）、写门禁状态、
 *   发布 GatePassed / GateBlocked。
 *
 * 门禁状态机：
 *   open → evaluating → passed（低危自动放行，发布 GatePassed decision='auto'）
 *                   ↘ blocked（需 HITL，发布 GateBlocked）
 *                          ↓ ApprovalCompleted
 *                       opened（发布 GateOpened + GatePassed decision='hitl'）
 *
 * 不变式：
 * - OR 永不持有/修改 Gate 状态，仅发 RiskSummaryReady
 * - merge MR / prod deploy 等门禁后动作由 PL 域执行（OR 不得越过 PL）
 */
import type { DomainEvent, RiskLevel, RunStage } from '@aegisci/shared/types';
import {
  PIPELINE_AGGREGATE_TYPES,
  PIPELINE_EVENT_TYPES,
  type PipelineEventContext,
  type GateBlockedPayload,
  type GateOpenedPayload,
  type GatePassedPayload,
  pipelineEvent,
} from '../events/pipeline-events';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 上游输入视图（Customer-Supplier：PL 为 OR 的 Customer）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * RiskSummary —— PL 消费 OR 发布的 RiskSummaryReady 事件时的载荷视图。
 * PL 只读取、不修改；OR 负责生成（结论聚合）。
 */
export interface RiskSummary {
  runId: string;
  tenantId: string;
  stage: RunStage;
  riskLevel: RiskLevel;
  /** 综合风险分值，OR 聚合多 Agent 结论得出 */
  riskScore: number;
  /** 结论条目指针（指向 Blackboard 中的 BlackboardEntry，铁律 3：通信走黑板） */
  conclusions: RiskConclusionRef[];
  generatedAt: string;
}

export interface RiskConclusionRef {
  agentId: string;
  entryId: string;
  confidence: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 门禁类型与状态
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type GateDecisionType = 'auto' | 'hitl';

export type GateState = 'open' | 'evaluating' | 'passed' | 'blocked' | 'opened';

/**
 * 自动放行风险阈值：riskLevel 低于等于此级别时自动放行。
 * 默认 G1 自动放行（DES-4 §4.2："低危自动放行"）；G2 及以上需 HITL。
 * 可在 evaluate() 时覆盖以适配租户策略预设。
 */
export const DEFAULT_AUTO_ALLOW_RISK_LEVEL: RiskLevel = 'G1';

const RISK_LEVEL_ORDER: Readonly<Record<RiskLevel, number>> = {
  G1: 1,
  G2: 2,
  G3: 3,
  G4: 4,
};

/** 两个风险级别比较：返回负数表示 a 更低 */
export function compareRiskLevel(a: RiskLevel, b: RiskLevel): number {
  return RISK_LEVEL_ORDER[a] - RISK_LEVEL_ORDER[b];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 错误类型
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class IllegalGateTransitionError extends Error {
  constructor(
    public readonly from: GateState,
    public readonly to: GateState,
    public readonly gateId: string,
  ) {
    super(`Illegal Gate transition: ${from} -> ${to} (gate ${gateId})`);
    this.name = 'IllegalGateTransitionError';
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 聚合根
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Gate 聚合根。每个 Run 每个门禁阶段一个实例（非单例）。
 *
 * 典型流程：
 *   1. PL 收到 OR 的 RiskSummaryReady → GateAggregate.open(riskSummary)
 *   2. evaluate() → 低危发 GatePassed(auto)，高危发 GateBlocked(HITL)
 *   3. HITL 审批完成 → approve() → 发 GateOpened + GatePassed(hitl)
 *   4. PL.Application 把 GatePassed 喂回 RunAggregate.applyGatePassed()
 */
export class GateAggregate {
  private readonly events: DomainEvent<unknown>[] = [];
  private _state: GateState;

  private constructor(
    private readonly record_: GateRecord,
    private readonly ctx: PipelineEventContext,
  ) {
    this._state = record_.state;
  }

  // ── 工厂 ──

  /**
   * 接收 RiskSummaryReady，打开门禁（open）。
   * 不在此处自动评估，留给 evaluate() 显式调用，便于策略预设注入。
   */
  static open(
    summary: RiskSummary,
    gateId: string,
    ctx: PipelineEventContext,
  ): GateAggregate {
    const record_: GateRecord = {
      gateId,
      runId: summary.runId,
      tenantId: summary.tenantId,
      stage: summary.stage,
      riskLevel: summary.riskLevel,
      riskScore: summary.riskScore,
      state: 'open',
      createdAt: ctx.now(),
    };
    return new GateAggregate(record_, ctx);
  }

  /** 从持久化快照重建 */
  static rehydrate(snapshot: GateRecord, ctx: PipelineEventContext): GateAggregate {
    return new GateAggregate({ ...snapshot }, ctx);
  }

  // ── 读模型 ──

  get gateId(): string {
    return this.record_.gateId;
  }
  get runId(): string {
    return this.record_.runId;
  }
  get tenantId(): string {
    return this.record_.tenantId;
  }
  get stage(): RunStage {
    return this.record_.stage;
  }
  get riskLevel(): RiskLevel {
    return this.record_.riskLevel;
  }
  get riskScore(): number {
    return this.record_.riskScore;
  }
  get state(): GateState {
    return this._state;
  }
  get decision(): GateDecisionType | undefined {
    return this.record_.decision;
  }
  get approvalTicketId(): string | undefined {
    return this.record_.approvalTicketId;
  }
  get snapshot(): Readonly<GateRecord> {
    return { ...this.record_, state: this._state };
  }
  get uncommittedEvents(): readonly DomainEvent<unknown>[] {
    return [...this.events];
  }

  markEventsCommitted(): void {
    this.events.length = 0;
  }

  // ── 门禁裁决 ──

  /**
   * 评估门禁：
   * - riskLevel <= autoAllowLevel（默认 G1）→ 自动放行，发 GatePassed(decision='auto')
   * - 否则 → 阻断，发 GateBlocked(requiresHitl=true)
   *
   * @param autoAllowLevel 自动放行的最高风险级别，默认 G1
   */
  evaluate(autoAllowLevel: RiskLevel = DEFAULT_AUTO_ALLOW_RISK_LEVEL): void {
    this.assertTransition(this._state, 'evaluating');
    this._state = 'evaluating';
    this.record_.decidedAt = this.ctx.now();

    const autoAllow = compareRiskLevel(this.record_.riskLevel, autoAllowLevel) <= 0;
    const evidence = [
      `riskLevel=${this.record_.riskLevel}`,
      `riskScore=${this.record_.riskScore}`,
    ];

    if (autoAllow) {
      this.record_.decision = 'auto';
      this._state = 'passed';
      this.emitGatePassed('auto', evidence);
    } else {
      this._state = 'blocked';
      this.emitGateBlocked(evidence);
    }
  }

  /**
   * HITL 审批通过（接收 PO.Approval 的 ApprovalCompleted + deploy-token）。
   * 发 GateOpened，紧随 GatePassed(decision='hitl')。
   */
  approve(params: { approvalTicketId: string; approvedBy: string }): void {
    if (this._state !== 'blocked') {
      throw new IllegalGateTransitionError(
        this._state,
        'opened',
        this.record_.gateId,
      );
    }
    this.record_.approvalTicketId = params.approvalTicketId;
    this.record_.openedBy = params.approvedBy;
    this.record_.decision = 'hitl';
    this.record_.decidedAt = this.ctx.now();

    // 先 GateOpened（门禁打开）
    this._state = 'opened';
    this.record<GateOpenedPayload>(PIPELINE_EVENT_TYPES.GATE_OPENED, {
      gateId: this.record_.gateId,
      runId: this.record_.runId,
      tenantId: this.record_.tenantId,
      stage: this.record_.stage,
      approvalTicketId: params.approvalTicketId,
      approvedBy: params.approvedBy,
      riskLevel: this.record_.riskLevel,
    });
    // 再 GatePassed(decision='hitl') —— 触发 Run 推进
    this.emitGatePassed('hitl', [
      `riskLevel=${this.record_.riskLevel}`,
      `approvalTicket=${params.approvalTicketId}`,
    ]);
  }

  // ── 内部 ──

  private emitGatePassed(
    decision: GateDecisionType,
    evidence: string[],
  ): void {
    this.record<GatePassedPayload>(PIPELINE_EVENT_TYPES.GATE_PASSED, {
      gateId: this.record_.gateId,
      runId: this.record_.runId,
      tenantId: this.record_.tenantId,
      stage: this.record_.stage,
      riskLevel: this.record_.riskLevel,
      riskScore: this.record_.riskScore,
      decision,
      approvalTicketId: this.record_.approvalTicketId,
      evidence,
    });
  }

  private emitGateBlocked(evidence: string[]): void {
    this.record<GateBlockedPayload>(PIPELINE_EVENT_TYPES.GATE_BLOCKED, {
      gateId: this.record_.gateId,
      runId: this.record_.runId,
      tenantId: this.record_.tenantId,
      stage: this.record_.stage,
      riskLevel: this.record_.riskLevel,
      riskScore: this.record_.riskScore,
      requiresHitl: true,
      reason: `Risk level ${this.record_.riskLevel} requires human approval`,
      evidence,
    });
  }

  private assertTransition(from: GateState, to: GateState): void {
    const allowed: Readonly<Record<GateState, readonly GateState[]>> = {
      open: ['evaluating'],
      evaluating: ['passed', 'blocked'],
      passed: [],
      blocked: ['opened'],
      opened: [],
    };
    if (!allowed[from]?.includes(to)) {
      throw new IllegalGateTransitionError(from, to, this.record_.gateId);
    }
  }

  private record<TPayload>(
    type: (typeof PIPELINE_EVENT_TYPES)[keyof typeof PIPELINE_EVENT_TYPES],
    payload: TPayload,
  ): void {
    this.events.push(
      pipelineEvent<TPayload>(
        type,
        PIPELINE_AGGREGATE_TYPES.GATE,
        this.record_.gateId,
        this.record_.tenantId,
        payload,
        this.ctx,
      ),
    );
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 持久化记录
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface GateRecord {
  gateId: string;
  runId: string;
  tenantId: string;
  stage: RunStage;
  riskLevel: RiskLevel;
  riskScore: number;
  state: GateState;
  decision?: GateDecisionType;
  approvalTicketId?: string;
  openedBy?: string;
  createdAt: string;
  decidedAt?: string;
}
