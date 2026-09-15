/**
 * TaskPlan 聚合根（OR 域）
 *
 * 对应设计文档：
 * - ADD §5.2 / detailed-design §4.2 Orchestration 状态机
 * - detailed-design §4.3 协作模型：阶段性流水协作 + 黑板共享
 *
 * 职责：
 * - 解析 PR 上下文 → 生成结构化 TaskPlan（Planner → 并行 Reviewer/Tester/Security → Ops）。
 * - 持有编排状态（OrchestrationStateMachine），驱动 Planning → Dispatching → ... → Done。
 * - 分派 Agent（M1 黑板默认 / M3 定向委托），不直接读取任何 AgentContext。
 * - 聚合 Blackboard 结论 → 生成 riskSummary → 发布 RiskSummaryReady。
 *
 * 边界铁律：
 * - OR 不持有 Run/Gate 状态，不发布门禁裁决事件（归 PL）。
 * - OR 不越过 PL 操作 Git 合并/生产部署等外部系统。
 * - 风险摘要只引用 Blackboard 条目 ID，不内联原始数据（防绕过权限的数据搬运）。
 */
import type { AgentRole, RiskLevel, RunTrigger } from '@aegisci/shared/types';
import {
  OrchestrationStateMachine,
  OrchestrationState,
  OrchestrationTrigger,
} from '../orchestration-state-machine';
import type {
  DelegationRequestedEvent,
  RiskSummaryReadyEvent,
  RiskSummaryReadyPayload,
  TaskDispatchedEvent,
  TaskDispatchedPayload,
} from '../events/orchestration-events';
import type { BlackboardSnapshot } from './blackboard.aggregate';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 结构化计划
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 单个子任务（一个 Agent dispatch 单元） */
export interface PlannedTask {
  taskId: string;
  role: AgentRole;
  agentId: string; // 由 Planner 根据能力匹配选择
  scope?: string; // M3 委托时的 scope 收窄
  tokenBudget: number; // 源自 AgentCard.model.budget
  dependsOn: string[]; // 阶段流水依赖（结构性协作）
  mode: 'M1_blackboard' | 'M3_delegation';
  parentEntryId?: string; // M3 委托链标记
  ttlMs?: number; // M3 默认 300000(5min)
  dispatched: boolean;
  concluded: boolean;
}

/** PR 上下文输入（由 PL 在 RunCreated 后推送，OR 不写 Run.stage） */
export interface PrContext {
  runId: string;
  tenantId: string;
  trigger: RunTrigger;
  diffRef: string; // 代码变更引用（OR 不直接拉 diff，仅持有引用，取数走工具链+权限）
  changedFiles: string[];
  riskHint?: RiskLevel;
  globalConstraints: string[];
}

/** 结构化计划 */
export interface TaskPlanData {
  taskPlanId: string;
  runId: string;
  tenantId: string;
  prContext: PrContext;
  tasks: PlannedTask[];
  riskLevel: RiskLevel;
  requiresHumanApproval: boolean; // 高风险计划需人确认（PendingPlanReview）
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 聚合根
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class TaskPlan {
  private readonly data: TaskPlanData;
  private readonly sm = new OrchestrationStateMachine();
  /** 该计划产生的领域事件（待 application service 发布到 EventBus） */
  private readonly pendingEvents: Array<TaskDispatchedEvent | RiskSummaryReadyEvent> = [];

  private constructor(data: TaskPlanData) {
    this.data = data;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 工厂：解析 PR 上下文 → 结构化计划
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 从 PR 上下文解析出结构化 TaskPlan。
   * 规划策略（结构性协作）：
   *   Planner → 并行(Reviewer/Tester/Security) → Ops
   * 风险分级：
   *   - G1/G2：AutoLowRisk，直接进 Dispatching。
   *   - G3/G4：requiresHumanApproval=true，需人确认后进 Dispatching。
   */
  static fromPrContext(
    taskPlanId: string,
    ctx: PrContext,
    plannerAgentId: string,
    workerAgentIds: { role: AgentRole; agentId: string; tokenBudget: number }[],
  ): TaskPlan {
    const riskLevel: RiskLevel = ctx.riskHint ?? 'G2';
    const requiresHumanApproval = riskLevel === 'G3' || riskLevel === 'G4';

    const tasks: PlannedTask[] = [
      {
        taskId: `${taskPlanId}#planner`,
        role: 'planner',
        agentId: plannerAgentId,
        tokenBudget: workerAgentIds.find((w) => w.role === 'planner')?.tokenBudget ?? 4000,
        dependsOn: [],
        mode: 'M1_blackboard',
        dispatched: false,
        concluded: false,
      },
      ...workerAgentIds
        .filter((w) => w.role !== 'planner')
        .map((w) => ({
          taskId: `${taskPlanId}#${w.role}`,
          role: w.role,
          agentId: w.agentId,
          tokenBudget: w.tokenBudget,
          dependsOn: [`${taskPlanId}#planner`],
          mode: 'M1_blackboard' as const,
          dispatched: false,
          concluded: false,
        })),
    ];

    return new TaskPlan({
      taskPlanId,
      runId: ctx.runId,
      tenantId: ctx.tenantId,
      prContext: ctx,
      tasks,
      riskLevel,
      requiresHumanApproval,
      createdAt: new Date().toISOString(),
    });
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 状态推进（与状态机对齐）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** 计划批准（人审或 AutoLowRisk）→ 进入 Dispatching */
  approve(trigger: OrchestrationTrigger = 'PlanAutoLowRisk'): void {
    if (this.data.requiresHumanApproval && trigger !== 'PlanApproved') {
      // 高风险必须显式 PlanApproved
      throw new Error('High-risk TaskPlan requires explicit human approval (PlanApproved)');
    }
    this.sm.transition(trigger);
  }

  /** 分派下一个待分派任务，产生 TaskDispatched 事件 */
  dispatchNext(blackboardSnapshot: BlackboardSnapshot, builder: (payload: TaskDispatchedPayload) => TaskDispatchedEvent): void {
    if (this.sm.current !== 'Planning' && this.sm.current !== 'Dispatching') {
      throw new Error(`Dispatch only allowed in Planning/Dispatching, current=${this.sm.current}`);
    }
    if (this.sm.current === 'Planning') {
      this.sm.transition('PlanAutoLowRisk');
    }
    const pending = this.data.tasks.find((t) => !t.dispatched && this.depsReady(t));
    if (!pending) {
      // 所有任务已分派 → 推进到 AwaitingAgents
      if (this.sm.current === 'Dispatching') this.sm.transition('AllAgentsDispatched');
      return;
    }
    pending.dispatched = true;
    const evt = builder({
      runId: this.data.runId,
      taskPlanId: this.data.taskPlanId,
      agentId: pending.agentId,
      role: pending.role,
      scope: pending.scope,
      tokenBudget: pending.tokenBudget,
      blackboardSnapshotRef: blackboardSnapshot.blackboardSessionId,
      mode: pending.mode,
      parentEntryId: pending.parentEntryId,
      ttlMs: pending.ttlMs,
    });
    this.pendingEvents.push(evt);

    // 若全部已分派 → 推进状态
    if (this.data.tasks.every((t) => t.dispatched) && this.sm.current === 'Dispatching') {
      this.sm.transition('AllAgentsDispatched');
    }
  }

  /** 收到一个 Agent 结论 → 标记完成；全部完成则推进并生成 riskSummary */
  collectConclusion(taskId: string, blackboardEntryId: string, builder: (p: { agentId: string; blackboardEntryId: string; confidence: number; severity: 'info' | 'warn' | 'critical' }) => void): void {
    const task = this.data.tasks.find((t) => t.taskId === taskId);
    if (!task || task.concluded) return;
    task.concluded = true;
    builder({ agentId: task.agentId, blackboardEntryId, confidence: 0.8, severity: 'info' });

    if (this.data.tasks.every((t) => t.concluded) && this.sm.current === 'AwaitingAgents') {
      this.sm.transition('AllAgentsConcluded');
      this.publishRiskSummary(blackboardEntryId);
    }
  }

  /** 生成 riskSummary 并发布 RiskSummaryReady（OR → PL 唯一耦合点之一） */
  publishRiskSummary(_blackboardEntryId: string): RiskSummaryReadyEvent {
    if (this.sm.current !== 'ConclusionsAggregated') {
      throw new Error(`RiskSummary requires ConclusionsAggregated state, current=${this.sm.current}`);
    }
    const summary: RiskSummaryReadyPayload = {
      runId: this.data.runId,
      taskPlanId: this.data.taskPlanId,
      riskLevel: this.data.riskLevel,
      entryIds: [], // 由 service 侧从 BlackboardSession 填充（聚合根不持有条目本体）
      criticalCount: 0,
      contributors: this.data.tasks.map((t) => t.agentId),
      summary: `Risk summary for run ${this.data.runId} (level=${this.data.riskLevel})`,
    };
    const eventId = `evt_risksummary_${this.data.taskPlanId}_${Date.now().toString(36)}`;
    const event: RiskSummaryReadyEvent = {
      eventId,
      eventType: 'or.risk.summary.ready',
      aggregateId: this.data.taskPlanId,
      aggregateType: 'TaskPlan',
      tenantId: this.data.tenantId,
      payload: summary,
      timestamp: new Date().toISOString(),
      traceId: this.data.prContext.runId,
      spanId: `span_risksummary_${Date.now().toString(36)}`,
    };
    this.pendingEvents.push(event);
    this.sm.transition('RiskSummaryPublished');
    return event;
  }

  /** 收到 PL 门禁结果 → Done（终态） */
  onGateResult(): void {
    this.sm.onGateResultReceived();
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // M3 定向委托请求（Agent → OR）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 生成 DelegationRequested 事件。
   * 委托约束（detailed-design §4.6.4）：
   * - 单跳限制：不可链式传递（A→B→C）——service 侧校验 toAgentRole 不为 planner。
   * - scope 收窄：必须声明 scope（模块/目录/环境）。
   * - TTL 默认 5min，超时自动取消。
   * - 委托链归因：Blackboard 条目标记 delegatedBy。
   */
  requestDelegation(
    cmd: { fromAgentId: string; toAgentRole: AgentRole; scope: string; reason: string; parentEntryId: string },
    builder: (payload: import('../events/orchestration-events').DelegationRequestedPayload) => DelegationRequestedEvent,
  ): DelegationRequestedEvent {
    if (!cmd.scope) throw new Error('Delegation requires scope narrowing (module/dir/env)');
    const evt = builder({
      runId: this.data.runId,
      fromAgentId: cmd.fromAgentId,
      toAgentRole: cmd.toAgentRole,
      scope: cmd.scope,
      reason: cmd.reason,
      parentEntryId: cmd.parentEntryId,
      ttlMs: 300000, // 5min
    });
    this.pendingEvents.push(evt as unknown as TaskDispatchedEvent);
    return evt;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 访问器
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  get taskPlanId(): string {
    return this.data.taskPlanId;
  }
  get runId(): string {
    return this.data.runId;
  }
  get tenantId(): string {
    return this.data.tenantId;
  }
  get riskLevel(): RiskLevel {
    return this.data.riskLevel;
  }
  get state(): OrchestrationState {
    return this.sm.current;
  }
  get tasks(): ReadonlyArray<PlannedTask> {
    return this.data.tasks;
  }
  /** 待发布事件（application service 拉取后清空） */
  pullPendingEvents(): Array<TaskDispatchedEvent | RiskSummaryReadyEvent> {
    const events = [...this.pendingEvents];
    this.pendingEvents.length = 0;
    return events;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 私有
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private depsReady(t: PlannedTask): boolean {
    return t.dependsOn.every((dep) => this.data.tasks.find((x) => x.taskId === dep)?.concluded ?? false);
  }
}
