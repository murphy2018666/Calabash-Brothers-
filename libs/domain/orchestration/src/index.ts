/**
 * Orchestration (OR) 域 —— 公共 API
 *
 * 对应设计文档：
 * - DES-3 DDD 上下文：Orchestration 限界上下文
 * - ADD §5.2 Orchestration 状态机
 * - detailed-design §4.6 多 Agent 通信方案
 *
 * 职责：
 * - 持有 Orchestrator 状态机（聚合根 TaskPlan / BlackboardSession）。
 * - 分派 Agent、经 Blackboard 收集结论。
 * - 聚合结论生成 riskSummary → 发布 RiskSummaryReady（OR → PL）。
 *
 * 边界铁律（OR 永不越过）：
 * - 不发布门禁裁决事件（GatePassed/GateBlocked 归 PL 域）。
 * - 不持有/修改 Run 与 Gate 状态（唯一写者是 PL 域）。
 * - 不直接操作 Git 合并/生产部署等外部系统。
 *
 * 通信三模式：
 * - M1 blackboard（默认）/ M2 event notification / M3 directed delegation（单跳、scope 收窄、TTL 5min）
 */
export * from './events/orchestration-events';
export * from './orchestration-state-machine';
export * from './aggregates/task-plan.aggregate';
export * from './aggregates/blackboard.aggregate';
export * from './services/blackboard.service';
export * from './services/agent-dispatcher';
export { OrchestrationModule } from './orchestration.module';

// DI 令牌（OR 域端口，由控制面注入实现）
export {
  BLACKBOARD_REPOSITORY,
  OR_EVENT_PUBLISHER,
  type BlackboardRepository,
  type OrEventPublisher,
} from './services/blackboard.service';
export { TASK_PLAN_REPOSITORY, type TaskPlanRepository } from './services/agent-dispatcher';
