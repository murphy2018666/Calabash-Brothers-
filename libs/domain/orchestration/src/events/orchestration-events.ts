/**
 * Orchestration (OR) 域领域事件
 *
 * 对应设计文档：
 * - DES-3 DDD 上下文 / DES-4 领域事件
 * - ADD §5.2 Orchestration 状态机
 * - detailed-design §4.6 多 Agent 通信方案
 *
 * 职责边界（铁律）：
 * - OR 只发布"事实"事件（TaskDispatched / AgentConcluded / RiskSummaryReady），
 *   不发布门禁裁决事件（GatePassed/GateBlocked 归 PL 域）。
 * - OR 永不越过 PL 操作外部系统；RiskSummaryReady 是 OR → PL 的唯一耦合点之一。
 *
 * 事件信封复用 @aegisci/shared/types 的 DomainEvent（含 traceId/spanId，用于 W3C Trace 跨域传播）。
 */
import type { DomainEvent, RiskLevel } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 事件类型常量（NATS subject 命名约定：or.{domain}.{verb}）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const OR_EVENT_TYPES = {
  TASK_DISPATCHED: 'or.task.dispatched',
  AGENT_CONCLUDED: 'or.agent.concluded',
  RISK_SUMMARY_READY: 'or.risk.summary.ready',
  DELEGATION_REQUESTED: 'or.delegation.requested',
  BLACKBOARD_ENTRY_ADDED: 'or.blackboard.entry.added',
} as const;

export type OrEventType = (typeof OR_EVENT_TYPES)[keyof typeof OR_EVENT_TYPES];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 通信模式（M1/M2/M3）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 通信模式：
 * - M1 blackboard —— 黑板模式（默认，异步追加，无直接依赖）
 * - M2 event      —— 事件通知（跨阶段，发布/订阅，仅传引用不传原始数据）
 * - M3 delegation —— 定向委托（同阶段，单跳，scope 收窄，TTL 5min）
 */
export type CommunicationMode = 'M1_blackboard' | 'M2_event' | 'M3_delegation';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Payload 契约
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** TaskDispatched —— OR 分派 Agent 执行子任务 */
export interface TaskDispatchedPayload {
  runId: string;
  taskPlanId: string;
  agentId: string;
  role: string;
  scope?: string; // M3 委托时的 scope 收窄（模块/目录/环境）
  tokenBudget: number;
  blackboardSnapshotRef: string; // dispatch 时注入的黑板快照引用
  mode: CommunicationMode;
  parentEntryId?: string; // M3 委托链标记（delegated-by）
  ttlMs?: number; // M3 默认 5min(300000)
}

/** AgentConcluded —— Agent 追加结论到 Blackboard 后由 OR 聚合发出 */
export interface AgentConcludedPayload {
  runId: string;
  taskPlanId: string;
  agentId: string;
  blackboardEntryId: string;
  confidence: number;
  severity: 'info' | 'warn' | 'critical';
  /** 是否来自委托链（M3）——用于审计归因 */
  delegatedBy?: string;
}

/** RiskSummaryReady —— OR 聚合所有 Agent 结论生成的风险摘要（OR → PL 的关键事件） */
export interface RiskSummaryReadyPayload {
  runId: string;
  taskPlanId: string;
  riskLevel: RiskLevel;
  /** 各 Agent 结论条目引用（数据本体仍在 Blackboard，不内联） */
  entryIds: string[];
  criticalCount: number;
  contributors: string[];
  /** 风险摘要（结构化，≤500 字） */
  summary: string;
}

/** DelegationRequested —— M3 定向委托请求（Agent → OR） */
export interface DelegationRequestedPayload {
  runId: string;
  fromAgentId: string;
  toAgentRole: string;
  scope: string; // 必须声明 scope（模块/目录/环境）
  reason: string;
  parentEntryId: string; // 触发委托的黑板条目
  ttlMs: number; // 默认 300000(5min)，超时自动取消
}

/** BlackboardEntryAdded —— Blackboard 追加条目（M1 默认通道） */
export interface BlackboardEntryAddedPayload {
  runId: string;
  blackboardSessionId: string;
  entryId: string;
  contributor: string;
  entryType: 'finding' | 'risk' | 'evidence' | 'conclusion';
  severity: 'info' | 'warn' | 'critical';
  traceSpanId: string;
  idempotencyKey: string; // (runId, agentId, conclusionHash)
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 强类型事件别名（复用 DomainEvent 信封）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type TaskDispatchedEvent = DomainEvent<TaskDispatchedPayload>;
export type AgentConcludedEvent = DomainEvent<AgentConcludedPayload>;
export type RiskSummaryReadyEvent = DomainEvent<RiskSummaryReadyPayload>;
export type DelegationRequestedEvent = DomainEvent<DelegationRequestedPayload>;
export type BlackboardEntryAddedEvent = DomainEvent<BlackboardEntryAddedPayload>;

/** OR 域所有事件类型的联合（便于 EventEmitter / 事件处理器类型推导） */
export type OrDomainEvent =
  | TaskDispatchedEvent
  | AgentConcludedEvent
  | RiskSummaryReadyEvent
  | DelegationRequestedEvent
  | BlackboardEntryAddedEvent;
