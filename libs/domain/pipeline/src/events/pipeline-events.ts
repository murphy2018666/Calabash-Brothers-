/**
 * PL（Pipeline）域领域事件定义
 *
 * 对应设计文档：
 * - DES-3 PL 限界上下文（聚合根：PipelineDef / Run / Gate）
 * - ADD §3.2 跨域三条铁律（Run.stage 唯一写者是 PL；Gate 归 PL）
 *
 * PL 域对外发布的领域事件：
 *   RunCreated, StageAdvanced, GatePassed, GateBlocked, GateOpened,
 *   RunCompleted, RunFailed, JobDispatched（exec.job.assign 命名空间归属 PL）
 *
 * PL 域消费的上游事件（来自 OR）：
 *   RiskSummaryReady —— 见 aggregates/gate.aggregate.ts 的 RiskSummary 视图
 *
 * 约定：所有事件 payload 为不可变快照，事件通过领域事件总线（NATS JetStream）
 * 投递，Audit 域（AU）以 Conformist 模式订阅全域事件做 WORM 固化。
 */
import type {
  DomainEvent,
  RiskLevel,
  RunStage,
  RunStatus,
  RunTrigger,
} from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 事件类型与聚合根类型常量
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * PL 域事件类型字符串。
 * `pipeline.job.dispatched` 对应 exec.job.assign 命名空间（CG 桥接器订阅投递给 Runner）。
 */
export const PIPELINE_EVENT_TYPES = {
  RUN_CREATED: 'pipeline.run.created',
  STAGE_ADVANCED: 'pipeline.run.stage_advanced',
  GATE_PASSED: 'pipeline.gate.passed',
  GATE_BLOCKED: 'pipeline.gate.blocked',
  GATE_OPENED: 'pipeline.gate.opened',
  RUN_COMPLETED: 'pipeline.run.completed',
  RUN_FAILED: 'pipeline.run.failed',
  JOB_DISPATCHED: 'pipeline.job.dispatched',
} as const;

export type PipelineEventType =
  (typeof PIPELINE_EVENT_TYPES)[keyof typeof PIPELINE_EVENT_TYPES];

/** PL 域聚合根类型标识（写入 DomainEvent.aggregateType） */
export const PIPELINE_AGGREGATE_TYPES = {
  RUN: 'Run',
  GATE: 'Gate',
} as const;

export type PipelineAggregateType =
  (typeof PIPELINE_AGGREGATE_TYPES)[keyof typeof PIPELINE_AGGREGATE_TYPES];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 事件载荷（Payload）契约
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** RunCreated：Run 聚合根创建（同时写入初始 stage，铁律 1 由 PL 唯一写） */
export interface RunCreatedPayload {
  runId: string;
  tenantId: string;
  pipelineId: string;
  status: RunStatus;
  stage: RunStage;
  trigger: RunTrigger;
  /** 写者恒为 'PL'（状态机守卫校验） */
  writer: string;
}

/** StageAdvanced：Run.stage 推进（PL 唯一写者，附 status 迁移） */
export interface StageAdvancedPayload {
  runId: string;
  tenantId: string;
  fromStage: RunStage;
  toStage: RunStage;
  fromStatus: RunStatus;
  toStatus: RunStatus;
  writer: string;
}

/**
 * GatePassed：门禁放行。
 * - decision='auto'：低危自动放行（G1）
 * - decision='hitl'：经人工审批（ApprovalCompleted）后放行，附 approvalTicketId
 */
export interface GatePassedPayload {
  gateId: string;
  runId: string;
  tenantId: string;
  stage: RunStage;
  riskLevel: RiskLevel;
  riskScore: number;
  decision: 'auto' | 'hitl';
  approvalTicketId?: string;
  evidence: string[];
}

/** GateBlocked：门禁阻断（需 HITL 人工审批，铁律 2：OR 不得越过 PL 操作） */
export interface GateBlockedPayload {
  gateId: string;
  runId: string;
  tenantId: string;
  stage: RunStage;
  riskLevel: RiskLevel;
  riskScore: number;
  requiresHitl: true;
  reason: string;
  evidence: string[];
}

/** GateOpened：HITL 审批通过后门禁打开（紧随 GatePassed decision='hitl'） */
export interface GateOpenedPayload {
  gateId: string;
  runId: string;
  tenantId: string;
  stage: RunStage;
  approvalTicketId: string;
  approvedBy: string;
  riskLevel: RiskLevel;
}

/** RunCompleted：Run 终态完成（deploying → completed） */
export interface RunCompletedPayload {
  runId: string;
  tenantId: string;
  stage: RunStage;
  completedAt: string;
}

/** RunFailed：Run 终态失败（任意活跃态 → failed） */
export interface RunFailedPayload {
  runId: string;
  tenantId: string;
  stage: RunStage;
  reason: string;
  failedAt: string;
}

/**
 * JobDispatched：PL 向 Runner 派发一次性沙箱 Job（经 Connection Gateway）。
 * 对应 exec.job.assign.{tenant}.{pool} 主题；Runner 按 (runId, jobId, attempt) 幂等。
 */
export interface JobDispatchedPayload {
  runId: string;
  tenantId: string;
  jobId: string;
  stage: RunStage;
  attempt: number;
  pool: string;
  spec: Record<string, unknown>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 事件构造工厂
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 事件构造依赖：由 PL.Application 注入（基于 ulid + 时钟 + 当前 trace 上下文）。
 * 设计要求：TraceId/SpanId 为一等公民，不可关闭（ADD §2.5 可观测性）。
 */
export interface PipelineEventContext {
  /** 生成全局唯一 eventId（ulid） */
  nextEventId: () => string;
  /** 当前 UTC ISO 时间 */
  now: () => string;
  /** 当前链路 traceId（来自控制面请求上下文） */
  traceId: string;
  /** 当前 spanId */
  spanId: string;
}

/**
 * 构造一个 PL 域 DomainEvent。
 * 该工厂集中填充事件信封公共字段，确保 traceId/spanId/eventId 不被遗漏。
 */
export function pipelineEvent<TPayload>(
  eventType: PipelineEventType,
  aggregateType: PipelineAggregateType,
  aggregateId: string,
  tenantId: string,
  payload: TPayload,
  ctx: PipelineEventContext,
): DomainEvent<TPayload> {
  return {
    eventId: ctx.nextEventId(),
    eventType,
    aggregateId,
    aggregateType,
    tenantId,
    payload,
    timestamp: ctx.now(),
    traceId: ctx.traceId,
    spanId: ctx.spanId,
  };
}
