/**
 * PL（Pipeline）域 NestJS 模块定义
 *
 * 对应设计文档：
 * - DES-3 PL 限界上下文（模块即 DDD 模块边界）
 * - ADD §2 Level 2 容器视图：模块化单体承载 7 限界上下文
 * - ADD §3 上下文映射：PL 是 OR 的 Customer（上游定义契约）
 *
 * 职责边界：
 * - 提供领域服务（RunStateMachine）与聚合根工厂
 * - 声明与执行面适配器（Connection Gateway）的端口契约
 * - 声明仓储端口（Run / Gate 持久化由基础设施实现注入）
 *
 * 不做：
 * - 不持有 SMTP/Webhook 客户端（铁律 3：通知仅走平台出站适配器）
 * - 不直连 Runner（仅发 JobDispatched 事件，由 CG 桥接）
 */
import { Module } from '@nestjs/common';
import type { DomainEvent, Run, RunStage, RunTrigger } from '@aegisci/shared/types';
import { RunStateMachine } from './run-state-machine';
import { RunAggregate } from './aggregates/run.aggregate';
import { GateAggregate } from './aggregates/gate.aggregate';
import type { GateRecord, RiskSummary } from './aggregates/gate.aggregate';
import type { PipelineEventContext } from './events/pipeline-events';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// DI 注入令牌
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const PIPELINE_TOKENS = {
  /** Run 状态机守卫服务（无状态） */
  RUN_STATE_MACHINE: Symbol('PL_RUN_STATE_MACHINE'),
  /** 事件构造上下文（eventId/时钟/trace，由控制面请求上下文提供） */
  EVENT_CONTEXT: Symbol('PL_EVENT_CONTEXT'),
  /** Run 聚合根工厂 */
  RUN_AGGREGATE_FACTORY: Symbol('PL_RUN_AGGREGATE_FACTORY'),
  /** Gate 聚合根工厂 */
  GATE_AGGREGATE_FACTORY: Symbol('PL_GATE_AGGREGATE_FACTORY'),
  /** Run 仓储端口（基础设施实现） */
  RUN_REPOSITORY: Symbol('PL_RUN_REPOSITORY'),
  /** Gate 仓储端口（基础设施实现） */
  GATE_REPOSITORY: Symbol('PL_GATE_REPOSITORY'),
  /**
   * Connection Gateway 端口（PL 域执行面适配器）。
   * exec.* 主题命名空间归属 PL；桥接器订阅 JobDispatched 投递给 Runner，
   * 回传 exec.job.result 由 PL 消费。
   */
  CONNECTION_GATEWAY: Symbol('PL_CONNECTION_GATEWAY'),
  /**
   * 事件总线端口（跨域 NATS JetStream 桥接，D2-5）。
   * 用于在控制面内替代 EventEmitter2 进行异步事件发布/订阅。
   * 生产实现为 NATS JetStream 客户端，测试实现为内存桩。
   */
  EVENT_BUS: Symbol('PL_EVENT_BUS'),
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 端口接口（防腐层契约）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Connection Gateway 端口 —— PL 与 Runner 之间的语言边界收敛点（ADR-05）。
 * PL 不直连 Runner，仅经此端口发布 JobAssign / 接收 JobResult。
 */
export interface ConnectionGatewayPort {
  /** 投递 JobAssign（对应 JobDispatched 事件，at-least-once） */
  dispatchJob(params: {
    runId: string;
    jobId: string;
    attempt: number;
    pool: string;
    spec: Record<string, unknown>;
  }): Promise<void>;

  /** 取消在跑 Job（Runner 重连对账 / 判死后补发 JobCancel） */
  cancelJob(params: { runId: string; jobId: string; reason: string }): Promise<void>;

  /** 健康检查（Gateway 实例可达） */
  healthy(): Promise<boolean>;
}

/** Run 仓储端口（聚合根快照持久化，由基础设施适配 PG/Redis 实现） */
export interface RunRepositoryPort {
  load(runId: string): Promise<Run | null>;
  save(snapshot: Run): Promise<void>;
}

/** Gate 仓储端口 */
export interface GateRepositoryPort {
  load(gateId: string): Promise<GateRecord | null>;
  save(snapshot: GateRecord): Promise<void>;
}

/**
 * 事件总线端口（D2-5 PL↔OR 跨域 NATS 集成）。
 * 发布/订阅语义：publish 投递到 NATS 主题；subscribe 注册 handler；unsubscribe 移除。
 * 生产实现绑定 NATS JetStream，测试实现可替换为 InMemoryNatsEventBus。
 */
export interface EventBusPort {
  /** 发布领域事件（投递到对应 NATS subject） */
  publish<T>(event: DomainEvent<T>): Promise<void>;
  /** 订阅主题，handler 在事件到达时调用 */
  subscribe<T>(subject: string, handler: (event: DomainEvent<T>) => void | Promise<void>): Promise<void>;
  /** 取消订阅 */
  unsubscribe(subject: string, handler?: (event: DomainEvent<unknown>) => void): Promise<void>;
  /** 健康检查 */
  healthy(): Promise<boolean>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 聚合根工厂（注入状态机 + 事件上下文）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface RunAggregateFactory {
  create(params: {
    runId: string;
    tenantId: string;
    pipelineId: string;
    stage: RunStage;
    trigger: RunTrigger;
  }): RunAggregate;
  rehydrate(snapshot: Run): RunAggregate;
}

export interface GateAggregateFactory {
  open(summary: RiskSummary, gateId: string): GateAggregate;
  rehydrate(snapshot: GateRecord): GateAggregate;
}

/**
 * Run 聚合根工厂默认实现（绑定 RUN_STATE_MACHINE + EVENT_CONTEXT）。
 * 非 @Injectable，由下方 useFactory 手工构造，避免接口作为 DI token 的运行时擦除问题。
 */
class RunAggregateFactoryImpl implements RunAggregateFactory {
  constructor(
    private readonly sm: RunStateMachine,
    private readonly ctx: PipelineEventContext,
  ) {}

  create(params: {
    runId: string;
    tenantId: string;
    pipelineId: string;
    stage: RunStage;
    trigger: RunTrigger;
  }): RunAggregate {
    return RunAggregate.create(params, this.sm, this.ctx);
  }

  rehydrate(snapshot: Run): RunAggregate {
    return RunAggregate.rehydrate(snapshot, this.sm, this.ctx);
  }
}

/** Gate 聚合根工厂默认实现（绑定 EVENT_CONTEXT） */
class GateAggregateFactoryImpl implements GateAggregateFactory {
  constructor(private readonly ctx: PipelineEventContext) {}

  open(summary: RiskSummary, gateId: string): GateAggregate {
    return GateAggregate.open(summary, gateId, this.ctx);
  }

  rehydrate(snapshot: GateRecord): GateAggregate {
    return GateAggregate.rehydrate(snapshot, this.ctx);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 模块
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * PL 域模块。
 *
 * 注意：RunStateMachine / EVENT_CONTEXT 作为可替换实现由控制面在启动时注入；
 * ConnectionGatewayPort / 仓储端口由基础设施层（infra）绑定后再 export 给
 * PL.Application 使用。本模块仅声明契约与默认无状态服务。
 */
@Module({
  providers: [
    RunStateMachine,
    { provide: PIPELINE_TOKENS.RUN_STATE_MACHINE, useExisting: RunStateMachine },
    {
      provide: PIPELINE_TOKENS.EVENT_CONTEXT,
      useFactory: (): PipelineEventContext => ({
        // 默认实现：控制面应覆盖为基于 ulid + 请求 trace 的版本
        nextEventId: () =>
          `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        now: () => new Date().toISOString(),
        traceId: 'root',
        spanId: 'root',
      }),
    },
    {
      provide: PIPELINE_TOKENS.RUN_AGGREGATE_FACTORY,
      useFactory: (
        sm: RunStateMachine,
        ctx: PipelineEventContext,
      ): RunAggregateFactory => new RunAggregateFactoryImpl(sm, ctx),
      inject: [RunStateMachine, PIPELINE_TOKENS.EVENT_CONTEXT],
    },
    {
      provide: PIPELINE_TOKENS.GATE_AGGREGATE_FACTORY,
      useFactory: (ctx: PipelineEventContext): GateAggregateFactory =>
        new GateAggregateFactoryImpl(ctx),
      inject: [PIPELINE_TOKENS.EVENT_CONTEXT],
    },
  ],
  exports: [
    RunStateMachine,
    PIPELINE_TOKENS.RUN_STATE_MACHINE,
    PIPELINE_TOKENS.EVENT_CONTEXT,
    PIPELINE_TOKENS.RUN_AGGREGATE_FACTORY,
    PIPELINE_TOKENS.GATE_AGGREGATE_FACTORY,
    PIPELINE_TOKENS.CONNECTION_GATEWAY,
    PIPELINE_TOKENS.RUN_REPOSITORY,
    PIPELINE_TOKENS.GATE_REPOSITORY,
    PIPELINE_TOKENS.EVENT_BUS,
  ],
})
export class PipelineModule {}
