/**
 * Run 聚合根（PL 域）
 *
 * 对应设计文档：
 * - DES-3 PL 限界上下文：聚合根 Run（生命周期唯一写者）
 * - ADD §3.2 铁律 1：Run.stage 唯一写者是 PL
 * - ADD §3.2 铁律 2：Gate 归 PL；OR 发 RiskSummaryReady，PL 推进
 *
 * 职责：
 * 1. 持有 Run 状态快照（status + stage + trigger）
 * 2. 通过 RunStateMachine 守卫写者与迁移合法性
 * 3. 推进 stage（PL 唯一写者）并发布 StageAdvanced
 * 4. 处理 Gate 决策事件（GatePassed/GateBlocked）推进 status
 * 5. 向 Runner 派发 Job（经 Connection Gateway）发布 JobDispatched
 * 6. 收集未提交领域事件（Unit of Work 模式，由 PL.Application 在事务后 flush）
 *
 * 不变式：
 * - 所有 mutate 方法必须传 writer 并经状态机 assertWriter 校验
 * - 终态后任何 mutate 抛 RunAlreadyTerminalError
 * - 不直接调用外部系统（Git 合并 / 部署器）—— 仅发领域事件
 */
import type {
  DomainEvent,
  Run,
  RunStage,
  RunStatus,
  RunTrigger,
} from '@aegisci/shared/types';
import { RUN_WRITER, RunStateMachine } from '../run-state-machine';
import {
  PIPELINE_AGGREGATE_TYPES,
  PIPELINE_EVENT_TYPES,
  type PipelineEventContext,
  type JobDispatchedPayload,
  type RunCompletedPayload,
  type RunCreatedPayload,
  type RunFailedPayload,
  type StageAdvancedPayload,
  pipelineEvent,
} from '../events/pipeline-events';
import type { GatePassedPayload, GateBlockedPayload } from '../events/pipeline-events';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 聚合根
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Run 聚合根。每个 Run 实例一个聚合根对象（非单例，不经 DI 容器管理；
 * 由 PL.Application 的 RunAggregateFactory 注入状态机后创建）。
 */
export class RunAggregate {
  private readonly events: DomainEvent<unknown>[] = [];

  private constructor(
    private readonly state: Run,
    private readonly sm: RunStateMachine,
    private readonly ctx: PipelineEventContext,
  ) {}

  // ── 工厂 ──

  /**
   * 创建新 Run（pending 状态）并发布 RunCreated。
   * 初始 stage 由 PL 唯一写入（铁律 1）。
   */
  static create(
    params: {
      runId: string;
      tenantId: string;
      pipelineId: string;
      stage: RunStage;
      trigger: RunTrigger;
    },
    sm: RunStateMachine,
    ctx: PipelineEventContext,
  ): RunAggregate {
    const now = ctx.now();
    const state: Run = {
      runId: params.runId,
      tenantId: params.tenantId,
      pipelineId: params.pipelineId,
      status: 'pending',
      stage: params.stage,
      trigger: params.trigger,
      createdAt: now,
      updatedAt: now,
    };
    const agg = new RunAggregate(state, sm, ctx);
    agg.record<RunCreatedPayload>(PIPELINE_EVENT_TYPES.RUN_CREATED, {
      runId: state.runId,
      tenantId: state.tenantId,
      pipelineId: state.pipelineId,
      status: state.status,
      stage: state.stage,
      trigger: state.trigger,
      writer: RUN_WRITER,
    });
    return agg;
  }

  /**
   * 从持久化快照重建（不产生新事件）。
   */
  static rehydrate(snapshot: Run, sm: RunStateMachine, ctx: PipelineEventContext): RunAggregate {
    return new RunAggregate({ ...snapshot }, sm, ctx);
  }

  // ── 读模型 ──

  get runId(): string {
    return this.state.runId;
  }
  get tenantId(): string {
    return this.state.tenantId;
  }
  get status(): RunStatus {
    return this.state.status;
  }
  get stage(): RunStage {
    return this.state.stage;
  }
  get snapshot(): Readonly<Run> {
    return { ...this.state };
  }
  get uncommittedEvents(): readonly DomainEvent<unknown>[] {
    return [...this.events];
  }

  markEventsCommitted(): void {
    this.events.length = 0;
  }

  // ── 状态迁移（每个方法均经写者守卫 + 迁移校验） ──

  /** pending → planning */
  startPlanning(writer: string): void {
    this.transitionTo('planning', writer);
  }

  /** planning → dispatching */
  startDispatching(writer: string): void {
    this.transitionTo('dispatching', writer);
  }

  /** dispatching → reviewing */
  startReviewing(writer: string): void {
    this.transitionTo('reviewing', writer);
  }

  /** reviewing → gate_blocked（接 GateBlocked） */
  blockGate(writer: string): void {
    this.transitionTo('gate_blocked', writer);
  }

  /** gate_blocked | reviewing → gate_passed（接 GatePassed，低危自动放行） */
  passGate(writer: string): void {
    this.transitionTo('gate_passed', writer);
  }

  /** gate_passed → deploying */
  startDeploying(writer: string): void {
    this.transitionTo('deploying', writer);
  }

  /** deploying → completed，发布 RunCompleted */
  complete(writer: string): void {
    this.transitionTo('completed', writer);
    this.record<RunCompletedPayload>(PIPELINE_EVENT_TYPES.RUN_COMPLETED, {
      runId: this.state.runId,
      tenantId: this.state.tenantId,
      stage: this.state.stage,
      completedAt: this.ctx.now(),
    });
  }

  /** 任意活跃态 → failed，发布 RunFailed */
  fail(writer: string, reason: string): void {
    this.transitionTo('failed', writer);
    this.record<RunFailedPayload>(PIPELINE_EVENT_TYPES.RUN_FAILED, {
      runId: this.state.runId,
      tenantId: this.state.tenantId,
      stage: this.state.stage,
      reason,
      failedAt: this.ctx.now(),
    });
  }

  /** 任意活跃态 → cancelled */
  cancel(writer: string): void {
    this.transitionTo('cancelled', writer);
  }

  // ── stage 推进（PL 唯一写者，铁律 1） ──

  /**
   * 推进 Run.stage 到下一阶段。
   * @throws RunStageWriteViolationError 当 writer !== 'PL'
   */
  advanceStage(toStage: RunStage, writer: string): void {
    this.sm.assertWriter(writer, this.state.runId);
    if (toStage === this.state.stage) return;
    const fromStage = this.state.stage;
    const fromStatus = this.state.status;
    this.state.stage = toStage;
    this.state.updatedAt = this.ctx.now();
    this.record<StageAdvancedPayload>(PIPELINE_EVENT_TYPES.STAGE_ADVANCED, {
      runId: this.state.runId,
      tenantId: this.state.tenantId,
      fromStage,
      toStage,
      fromStatus,
      toStatus: this.state.status,
      writer: RUN_WRITER,
    });
  }

  // ── Gate 事件处理（来自 Gate 聚合根的决策） ──

  /**
   * 处理 GatePassed 事件：将 Run 推进到 gate_passed。
   * 适用：reviewing → gate_passed（低危自动）或 gate_blocked → gate_passed（HITL 后）。
   * 写者仍为 PL（Gate 与 Run 同属 PL 域，PL 内部推进）。
   */
  applyGatePassed(event: DomainEvent<GatePassedPayload>): void {
    if (event.payload.runId !== this.state.runId) return; // 不属于本 Run 的门禁事件，忽略
    // PL 内部推进，写者恒为 PL（Gate 与 Run 均为 PL 聚合根）
    if (this.state.status === 'reviewing' || this.state.status === 'gate_blocked') {
      this.transitionTo('gate_passed', RUN_WRITER);
    }
  }

  /**
   * 处理 GateBlocked 事件：将 Run 推进到 gate_blocked，等待 HITL 审批。
   */
  applyGateBlocked(event: DomainEvent<GateBlockedPayload>): void {
    if (event.payload.runId !== this.state.runId) return; // 不属于本 Run 的门禁事件，忽略
    if (this.state.status === 'reviewing') {
      this.transitionTo('gate_blocked', RUN_WRITER);
    }
  }

  // ── Job 派发（经 Connection Gateway 投递给 Runner） ──

  /**
   * 向 Runner 派发一次性沙箱 Job。
   * 仅发布 JobDispatched 事件（exec.job.assign 命名空间），
   * 由 Connection Gateway 订阅并桥接给 Runner；PL 不直连 Runner。
   */
  dispatchJob(params: {
    jobId: string;
    attempt: number;
    pool: string;
    spec: Record<string, unknown>;
  }): void {
    this.record<JobDispatchedPayload>(PIPELINE_EVENT_TYPES.JOB_DISPATCHED, {
      runId: this.state.runId,
      tenantId: this.state.tenantId,
      jobId: params.jobId,
      stage: this.state.stage,
      attempt: params.attempt,
      pool: params.pool,
      spec: params.spec,
    });
  }

  // ── 内部 ──

  /**
   * 状态迁移 + 写者守卫。
   * 每次迁移记录 StageAdvanced 事件（Unit of Work，事务后由 PL.Application flush）；
   * 仅 status 变更时 fromStage === toStage（payload 契约注明"附 status 迁移"）。
   */
  private transitionTo(to: RunStatus, writer: string): void {
    const next = this.sm.transition(this.state.status, to, writer, this.state.runId);
    const fromStatus = this.state.status;
    this.state.status = next;
    this.state.updatedAt = this.ctx.now();
    this.record<StageAdvancedPayload>(PIPELINE_EVENT_TYPES.STAGE_ADVANCED, {
      runId: this.state.runId,
      tenantId: this.state.tenantId,
      fromStage: this.state.stage,
      toStage: this.state.stage,
      fromStatus,
      toStatus: next,
      writer: RUN_WRITER,
    });
  }

  private record<TPayload>(
    type: (typeof PIPELINE_EVENT_TYPES)[keyof typeof PIPELINE_EVENT_TYPES],
    payload: TPayload,
  ): void {
    this.events.push(
      pipelineEvent<TPayload>(
        type,
        PIPELINE_AGGREGATE_TYPES.RUN,
        this.state.runId,
        this.state.tenantId,
        payload,
        this.ctx,
      ),
    );
  }
}
