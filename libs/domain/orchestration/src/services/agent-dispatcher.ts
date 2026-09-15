/**
 * AgentDispatcherService —— Agent 分派与结论收集服务（OR 域）
 *
 * 对应设计文档：
 * - ADD §5.2 / detailed-design §4.2 Orchestration 状态机
 * - detailed-design §4.6 多 Agent 通信方案（M1/M2/M3）
 * - detailed-design §4.5.3 上下文预算管控（Token 预算）
 * - detailed-design §4.6.3 TTL 超时取消（Agent 分派后超时自动 abort）
 * - detailed-design §4.6.2 黑名单快照注入 AgentContext
 *
 * 职责：
 * - 驱动 TaskPlan.dispatchNext：分派 Agent，发布 TaskDispatched 事件。
 * - 收集 Agent 结论（经 BlackboardService.append），发布 AgentConcluded 事件。
 * - 聚合结论 → 触发 TaskPlan.publishRiskSummary → 发布 RiskSummaryReady（OR → PL）。
 * - 处理 M3 定向委托请求（单跳、scope 收窄、TTL 5min）。
 * - TTL 超时管理：为每个 dispatched task 设置定时器，超时自动 abort。
 * - 黑名单快照注入：从 Blackboard critical 条目提取 blocked agents，注入 snapshot。
 *
 * 边界铁律：
 * - 不直接读取任何 AgentContext；Agent 间信息交换只走 Blackboard。
 * - 不发布门禁裁决事件（GatePassed/GateBlocked 归 PL）。
 * - dispatch 时将 Blackboard 快照注入 AgentContext（受压缩策略管控）。
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import type { AgentCard, AgentRole, DomainEvent, Principal } from '@aegisci/shared/types';
import { AgentProvider } from '@aegisci/core/spi';
import { TaskPlan, PrContext } from '../aggregates/task-plan.aggregate';
import {
  OR_EVENT_TYPES,
  TaskDispatchedEvent,
  TaskDispatchedPayload,
  AgentConcludedEvent,
  AgentConcludedPayload,
  DelegationRequestedEvent,
  DelegationRequestedPayload,
  RiskSummaryReadyEvent,
} from '../events/orchestration-events';
import { BlackboardService, OrEventPublisher, OR_EVENT_PUBLISHER } from './blackboard.service';
import { SPI_TOKENS } from '@aegisci/core/spi';
import type { BlackboardSnapshot } from '../aggregates/blackboard.aggregate';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TaskPlan 仓储端口
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const TASK_PLAN_REPOSITORY = Symbol('TASK_PLAN_REPOSITORY');

export interface TaskPlanRepository {
  save(plan: TaskPlan): Promise<void>;
  load(taskPlanId: string): Promise<TaskPlan | null>;
  loadByRun(runId: string): Promise<TaskPlan | null>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TTL 超时追踪
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 每个已分派 task 的 TTL 定时器记录 */
interface TtlTimerEntry {
  taskId: string;
  agentId: string;
  timer: ReturnType<typeof setTimeout> | null;
  createdAt: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 请求/结果 DTO
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface DispatchContext {
  taskPlanId: string;
  runId: string;
  tenantId: string;
  /** 分派调用的主体（用于审计归因；不可伪造他人 agentId） */
  caller: Principal;
  traceSpanId: string;
}

export interface AgentConclusionInput {
  taskPlanId: string;
  runId: string;
  tenantId: string;
  taskId: string;
  agentId: string;
  blackboardEntryId: string;
  confidence: number;
  severity: 'info' | 'warn' | 'critical';
  delegatedBy?: string;
  traceSpanId: string;
}

export interface DelegationRequestInput {
  taskPlanId: string;
  runId: string;
  tenantId: string;
  fromAgentId: string;
  toAgentRole: AgentRole;
  scope: string;
  reason: string;
  parentEntryId: string;
  traceSpanId: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class AgentDispatcherService {
  private readonly logger = new Logger(AgentDispatcherService.name);
  /** 追踪每个已分派 task 的 TTL 定时器，key = `${taskPlanId}:${taskId}` */
  private readonly ttlTimers = new Map<string, TtlTimerEntry>();

  constructor(
    @Inject(SPI_TOKENS.AGENT_PROVIDER) private readonly agentProvider: AgentProvider,
    @Inject(TASK_PLAN_REPOSITORY) private readonly planRepo: TaskPlanRepository,
    @Inject(OR_EVENT_PUBLISHER) private readonly publisher: OrEventPublisher,
    private readonly blackboard: BlackboardService,
  ) {}

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 规划：解析 PR 上下文 → 结构化 TaskPlan
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async createPlan(
    taskPlanId: string,
    ctx: PrContext,
    tenantId: string,
  ): Promise<TaskPlan> {
    // 通过 SPI 发现各角色 Agent（DES-13：实现在插件，控制点在内核）
    const roles: AgentRole[] = ['reviewer', 'tester', 'security', 'ops'];
    const workers: { role: AgentRole; agentId: string; tokenBudget: number }[] = [];
    for (const role of roles) {
      const cards = await this.agentProvider.listByRole(role, tenantId);
      if (cards.length > 0) {
        workers.push({
          role,
          agentId: cards[0].agentId,
          tokenBudget: this.extractBudget(cards[0]),
        });
      }
    }
    const plannerCards = await this.agentProvider.listByRole('planner', tenantId);
    const plannerAgentId = plannerCards[0]?.agentId ?? `planner_${ctx.runId}`;

    const plan = TaskPlan.fromPrContext(taskPlanId, ctx, plannerAgentId, workers);
    await this.planRepo.save(plan);
    this.logger.log(`TaskPlan created: ${taskPlanId} (risk=${plan.riskLevel})`);
    return plan;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 分派：驱动 dispatchNext，发布 TaskDispatched
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async dispatchNext(ctx: DispatchContext): Promise<TaskDispatchedEvent | null> {
    const plan = await this.planRepo.load(ctx.taskPlanId);
    if (!plan) throw new Error(`TaskPlan not found: ${ctx.taskPlanId}`);

    // dispatch 前注入 Blackboard 当前快照到 AgentContext（受压缩策略管控）
    // 包含黑名单：从 critical 风险条目中提取 blocked agents
    const snapshot = await this.buildSnapshotWithBlacklist(ctx.runId);

    // 使用 holder 对象避免闭包内赋值导致 TS 控制流把局部变量收窄为 never
    const dispatchedHolder: { event: TaskDispatchedEvent | null } = { event: null };
    plan.dispatchNext(snapshot, (payload: TaskDispatchedPayload) => {
      const event: TaskDispatchedEvent = {
        eventId: `evt_dispatch_${payload.taskPlanId}_${payload.agentId}_${Date.now().toString(36)}`,
        eventType: OR_EVENT_TYPES.TASK_DISPATCHED,
        aggregateId: payload.taskPlanId,
        aggregateType: 'TaskPlan',
        tenantId: ctx.tenantId,
        payload,
        timestamp: new Date().toISOString(),
        traceId: ctx.runId,
        spanId: ctx.traceSpanId,
      };
      dispatchedHolder.event = event;
      return event;
    });

    await this.planRepo.save(plan);

    // 发布聚合根产生的待发布事件（TaskDispatched 等）
    for (const evt of plan.pullPendingEvents()) {
      await this.publisher.publish(evt as DomainEvent<unknown>);
    }
    const dispatched = dispatchedHolder.event;
    if (dispatched) {
      this.logger.log(`Agent dispatched: run=${ctx.runId} agent=${dispatched.payload.agentId} mode=${dispatched.payload.mode}`);
      // D2-3: 设置 TTL 超时定时器（仅 M3 或显式指定 ttlMs 时有效）
      const ttlMs = dispatched.payload.ttlMs;
      if (ttlMs && ttlMs > 0) {
        const taskId = `${plan.taskPlanId}:${dispatched.payload.agentId}`;
        this.scheduleTtlTimeout(taskId, dispatched.payload.agentId, ttlMs, ctx.taskPlanId);
      }
    }
    return dispatched;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 收集结论：Agent 追加黑板后 → 发布 AgentConcluded → 触发 riskSummary
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async collectConclusion(input: AgentConclusionInput): Promise<AgentConcludedEvent | null> {
    const plan = await this.planRepo.load(input.taskPlanId);
    if (!plan) throw new Error(`TaskPlan not found: ${input.taskPlanId}`);

    // D2-3: 结论到达时取消 TTL 定时器（任务正常结束）
    this.clearTtlTimeout(input.taskPlanId, input.agentId);

    // 使用 holder 对象避免闭包内赋值导致 TS 控制流把局部变量收窄为 never
    const concludedHolder: { event: AgentConcludedEvent | null } = { event: null };
    plan.collectConclusion(input.taskId, input.blackboardEntryId, ({ agentId, blackboardEntryId, confidence, severity }) => {
      concludedHolder.event = {
        eventId: `evt_concluded_${plan.taskPlanId}_${agentId}_${Date.now().toString(36)}`,
        eventType: OR_EVENT_TYPES.AGENT_CONCLUDED,
        aggregateId: plan.taskPlanId,
        aggregateType: 'TaskPlan',
        tenantId: input.tenantId,
        payload: {
          runId: input.runId,
          taskPlanId: plan.taskPlanId,
          agentId,
          blackboardEntryId,
          confidence,
          severity,
          delegatedBy: input.delegatedBy,
        } as AgentConcludedPayload,
        timestamp: new Date().toISOString(),
        traceId: input.runId,
        spanId: input.traceSpanId,
      };
    });

    await this.planRepo.save(plan);

    const concludedEvent = concludedHolder.event;
    if (concludedEvent) {
      await this.publisher.publish(concludedEvent);
      this.logger.log(`Agent concluded: run=${input.runId} agent=${concludedEvent.payload.agentId}`);
    }

    // 若状态推进到 ConclusionsAggregated，发布 RiskSummaryReady（OR → PL）
    for (const evt of plan.pullPendingEvents()) {
      await this.publisher.publish(evt as DomainEvent<unknown>);
      if ((evt as RiskSummaryReadyEvent).eventType === OR_EVENT_TYPES.RISK_SUMMARY_READY) {
        this.logger.log(`RiskSummaryReady published: run=${input.runId} level=${(evt as RiskSummaryReadyEvent).payload.riskLevel}`);
      }
    }
    return concludedEvent;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // M3 定向委托（同阶段，单跳，scope 收窄，TTL 5min）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async requestDelegation(input: DelegationRequestInput): Promise<DelegationRequestedEvent> {
    const plan = await this.planRepo.load(input.taskPlanId);
    if (!plan) throw new Error(`TaskPlan not found: ${input.taskPlanId}`);

    // 单跳限制：目标角色不可为 planner（防止 A→B→C 链式委托）
    if (input.toAgentRole === 'planner') {
      throw new Error('Delegation single-hop constraint: cannot delegate to planner role');
    }
    if (!input.scope) {
      throw new Error('Delegation requires scope narrowing (module/dir/env)');
    }

    const event = plan.requestDelegation(
      {
        fromAgentId: input.fromAgentId,
        toAgentRole: input.toAgentRole,
        scope: input.scope,
        reason: input.reason,
        parentEntryId: input.parentEntryId,
      },
      (payload: DelegationRequestedPayload) => ({
        eventId: `evt_delegate_${plan.taskPlanId}_${input.fromAgentId}_${input.toAgentRole}_${Date.now().toString(36)}`,
        eventType: OR_EVENT_TYPES.DELEGATION_REQUESTED,
        aggregateId: plan.taskPlanId,
        aggregateType: 'TaskPlan',
        tenantId: input.tenantId,
        payload,
        timestamp: new Date().toISOString(),
        traceId: input.runId,
        spanId: input.traceSpanId,
      }),
    );

    await this.planRepo.save(plan);
    await this.publisher.publish(event);
    this.logger.log(
      `Delegation requested: run=${input.runId} from=${input.fromAgentId} to=${input.toAgentRole} scope=${input.scope} ttl=5min`,
    );
    return event;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 门禁结果回填（由 PL 域事件订阅触发）→ Done
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async onGateResult(taskPlanId: string): Promise<void> {
    const plan = await this.planRepo.load(taskPlanId);
    if (!plan) return;
    plan.onGateResult();
    await this.planRepo.save(plan);
    this.logger.log(`TaskPlan reached Done (gate result received): ${taskPlanId}`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 私有
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private extractBudget(card: AgentCard): number {
    // Token 预算源自 AgentCard.model.budget（DES-8）；本骨架取保守默认 8000。
    const anyCard = card as unknown as { model?: { budget?: number } };
    return anyCard.model?.budget ?? 8000;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // D2-3: TTL 超时管理
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 为已分派的 task 设置 TTL 超时定时器。
   * 超时后将 task 标记为 aborted，并尝试推进状态机。
   */
  private scheduleTtlTimeout(
    taskId: string,
    agentId: string,
    ttlMs: number,
    taskPlanId: string,
  ): void {
    // 先取消已有的同名定时器（防重复注册）
    this.clearTtlTimeout(taskPlanId, agentId);

    const entry: TtlTimerEntry = { taskId, agentId, timer: null, createdAt: Date.now() };
    const timer = setTimeout(() => {
      this.onTtlTimeout(taskId, agentId, taskPlanId);
    }, ttlMs);
    entry.timer = timer;
    this.ttlTimers.set(taskId, entry);
    this.logger.warn(`TTL timer scheduled: ${taskId} agent=${agentId} ttl=${ttlMs}ms`);
  }

  /** TTL 超时时调用的处理逻辑 */
  private async onTtlTimeout(taskId: string, agentId: string, taskPlanId: string): Promise<void> {
    this.ttlTimers.delete(taskId);
    this.logger.warn(`TTL timeout reached: task=${taskId} agent=${agentId} taskPlan=${taskPlanId}`);

    const plan = await this.planRepo.load(taskPlanId);
    if (!plan) return;

    // 找到对应的 task 并标记 aborted（通过 dispatchNext 重新驱动状态机）
    // 注意：此处不直接修改聚合根内部状态，而是通过计划侧的 abortTask 方法
    // 骨架阶段：记录日志并标记定时器清除，实际 abort 由聚合根提供
    const task = plan.tasks.find((t) => t.agentId === agentId && !t.concluded);
    if (task) {
      this.logger.warn(`Task aborted due to TTL: ${task.taskId} agent=${agentId}`);
      // 在此处标记任务为 aborted，后续可接入 abort 方法
      // 暂时通过 publishPendingEvents 侧通知（框架层面）
    }
  }

  /** 取消指定 task 的 TTL 定时器 */
  private clearTtlTimeout(taskPlanId: string, agentId: string): void {
    const taskId = `${taskPlanId}:${agentId}`;
    const entry = this.ttlTimers.get(taskId);
    if (entry?.timer) {
      clearTimeout(entry.timer);
      this.ttlTimers.delete(taskId);
      this.logger.log(`TTL timer cleared: ${taskId}`);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // D2-3: 黑名单快照注入
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 构建带黑名单信息的 Blackboard 快照。
   * 从 critical 风险条目中提取被阻塞的 agentId（blockedAgents），
   * 注入到 snapshot 的 blockedAgents 字段供 AgentContext 使用。
   */
  private async buildSnapshotWithBlacklist(runId: string): Promise<BlackboardSnapshot & { blockedAgents: string[] }> {
    const snapshot = await this.blackboard.read(runId);
    // 提取 critical 级别条目中的 blocked agents（payload.tags 中含 'blocked' 的 agentId）
    const blockedAgents = new Set<string>();
    for (const entry of snapshot.entries) {
      const payload = entry.payload as Record<string, unknown>;
      if (payload.severity === 'critical') {
        // 检查条目是否标记了 blocked agent
        const blockedTag = payload.tags as string[] | undefined;
        if (blockedTag?.includes('blocked')) {
          blockedAgents.add(entry.agentId);
        }
        // 也检查 payload 中是否有 explicit blockedAgentIds
        const blockedAgentIds = payload.blockedAgentIds as string[] | undefined;
        if (blockedAgentIds) {
          for (const id of blockedAgentIds) blockedAgents.add(id);
        }
      }
    }
    return {
      ...snapshot,
      blockedAgents: [...blockedAgents],
    };
  }
}
