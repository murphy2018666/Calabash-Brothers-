/**
 * PL（Pipeline）限界上下文 —— 公共 API
 *
 * 对应设计文档：
 * - DES-3 DDD 限界上下文：PL 域（聚合根 PipelineDef / Run / Gate）
 * - ADD §3.2 跨域三条铁律：
 *   1. Run.stage 唯一写者是 PL
 *   2. Gate 归 PL，裁决发起归 OR（PL 消费 RiskSummaryReady）
 *   3. 通知仅走平台出站适配器
 *
 * 公共 API 边界（仅以下符号对外可见，其余为内部实现）：
 * - 聚合根：RunAggregate, GateAggregate
 * - 领域服务：RunStateMachine（含写者守卫 + 迁移校验）
 * - 领域事件：PIPELINE_EVENT_TYPES + 各 Payload 契约
 * - 模块与端口：PipelineModule, PIPELINE_TOKENS, ConnectionGatewayPort,
 *   RunRepositoryPort, GateRepositoryPort, RunAggregateFactory, GateAggregateFactory
 */

// 聚合根
export { RunAggregate } from './aggregates/run.aggregate';
export {
  GateAggregate,
  DEFAULT_AUTO_ALLOW_RISK_LEVEL,
  compareRiskLevel,
} from './aggregates/gate.aggregate';
export type {
  RiskSummary,
  RiskConclusionRef,
  GateRecord,
  GateState,
  GateDecisionType,
} from './aggregates/gate.aggregate';

// 领域服务 / 状态机守卫
export {
  RunStateMachine,
  RUN_WRITER,
  RUN_STATE_TRANSITIONS,
  RUN_ACTIVE_STATES,
  RUN_TERMINAL_STATES,
} from './run-state-machine';
export type { RunWriter } from './run-state-machine';
export {
  RunStageWriteViolationError,
  IllegalRunTransitionError,
  RunAlreadyTerminalError,
} from './run-state-machine';
// IllegalGateTransitionError 定义于 gate.aggregate.ts
export { IllegalGateTransitionError } from './aggregates/gate.aggregate';

// 领域事件
export {
  PIPELINE_EVENT_TYPES,
  PIPELINE_AGGREGATE_TYPES,
  pipelineEvent,
} from './events/pipeline-events';
export type {
  PipelineEventType,
  PipelineAggregateType,
  PipelineEventContext,
  RunCreatedPayload,
  StageAdvancedPayload,
  GatePassedPayload,
  GateBlockedPayload,
  GateOpenedPayload,
  RunCompletedPayload,
  RunFailedPayload,
  JobDispatchedPayload,
} from './events/pipeline-events';

// NestJS 模块与端口
export { PipelineModule, PIPELINE_TOKENS } from './pipeline.module';
export type {
  ConnectionGatewayPort,
  RunRepositoryPort,
  GateRepositoryPort,
  EventBusPort,
  RunAggregateFactory,
  GateAggregateFactory,
} from './pipeline.module';
