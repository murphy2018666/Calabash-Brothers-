/**
 * OrchestratorBridgeService —— OR↔PL 事件桥接服务（D2-1）。
 *
 * 职责：
 * - 监听 OR 域发布的 RiskSummaryReady 事件 → 创建并评估 GateAggregate → 发布 GatePassed/GateBlocked。
 * - 监听 PL 域发布的 GateResult 事件（经由 gate.result 主题）→ 回调 AgentDispatcherService.onGateResult()。
 *
 * 跨域铁律：
 * - OR 不持有 Run/Gate 状态，本服务仅在事件驱动下触发 GateAggregate 操作，不做持久化。
 * - GatePassed/GateBlocked 事件的 trace/span 由本服务内联构造（对应 PipelineEventContext）。
 */
import { Injectable, Inject, Logger, OnModuleInit } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DomainEvent, RiskLevel, RunStage } from '@aegisci/shared/types';
import {
  GateAggregate,
  DEFAULT_AUTO_ALLOW_RISK_LEVEL,
  compareRiskLevel,
  PIPELINE_TOKENS,
  type EventBusPort,
} from '@aegisci/domain/pipeline';
import {
  TASK_PLAN_REPOSITORY,
  type TaskPlanRepository,
  AgentDispatcherService,
} from '@aegisci/domain/orchestration';
import {
  OR_EVENT_TYPES,
  type RiskSummaryReadyEvent,
} from '@aegisci/domain/orchestration';
import {
  PIPELINE_EVENT_TYPES,
  type PipelineEventType,
  type PipelineAggregateType,
} from '@aegisci/domain/pipeline';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PL 域事件类型常量（GateResult 桥接用）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const OR_GATE_RESULT_EVENT_TYPES = {
  GATE_RESULT: 'or.bridge.gate.result',
} as const;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class OrchestratorBridgeService implements OnModuleInit {
  private readonly logger = new Logger(OrchestratorBridgeService.name);

  constructor(
    @Inject(TASK_PLAN_REPOSITORY) private readonly planRepo: TaskPlanRepository,
    private readonly emitter: EventEmitter2,
    @Inject(AgentDispatcherService)
    private readonly dispatcher: AgentDispatcherService,
    @Inject(PIPELINE_TOKENS.EVENT_BUS) private readonly eventBus?: EventBusPort,
  ) {}

  onModuleInit(): void {
    // 订阅 PL 域门禁裁决事件（GatePassed / GateBlocked），回调 OR 的 onGateResult
    for (const eventType of [
      PIPELINE_EVENT_TYPES.GATE_PASSED,
      PIPELINE_EVENT_TYPES.GATE_BLOCKED,
    ]) {
      // 同步注册，内部处理 Promise（fire-and-forget），避免 EventEmitter2 对 async handler 的兼容问题
      this.emitter.on(eventType, (event: DomainEvent<unknown>) => {
        void this.handleGateResultEvent(eventType, event);
      });
    }

    this.logger.log('OrchestratorBridgeService initialized (subscribed to PL gate events)');
  }

  /**
   * 手动触发 RiskSummaryReady 处理（供测试直接调用，无需走事件总线）。
   * 也可由 WebhookController 在模拟场景下显式调用。
   */
  async handleRiskSummaryReady(event: RiskSummaryReadyEvent): Promise<void> {
    const { runId, taskPlanId, riskLevel, summary, criticalCount } = event.payload;

    this.logger.log(
      `Processing RiskSummaryReady: run=${runId} taskPlan=${taskPlanId} riskLevel=${riskLevel}`,
    );

    // 加载 TaskPlan 以获取 tenantId/阶段等信息
    const plan = await this.planRepo.load(taskPlanId);
    if (!plan) {
      this.logger.warn(`TaskPlan ${taskPlanId} not found, skipping gate evaluation`);
      return;
    }

    // 构造 GateAggregate（PL 侧）
    // 注意：这里需要 PipelineEventContext；使用默认 stub 实现（生产由控制面注入真实 context）
    const gateId = `gate_${taskPlanId}`;
    const gateCtx = createStubEventContext();
    const gate = GateAggregate.open(
      {
        runId,
        tenantId: plan.tenantId,
        stage: 'review' as RunStage, // 默认 review 阶段；生产由 PL 注入实际 stage
        riskLevel,
        riskScore: computeRiskScore(riskLevel),
        conclusions: [],
        generatedAt: event.timestamp,
      },
      gateId,
      gateCtx,
    );

    // 评估门禁
    gate.evaluate(DEFAULT_AUTO_ALLOW_RISK_LEVEL);

    // 发布门禁事件到 EventBus（NATS）或 EventEmitter2（兼容）
    for (const evt of gate.uncommittedEvents) {
      if (this.eventBus) {
        await this.eventBus.publish(evt);
        this.logger.log(`Gate event published via EventBus: ${evt.eventType} gateId=${gateId}`);
      } else {
        this.emitter.emit(evt.eventType, evt);
        this.logger.log(`Gate event published: ${evt.eventType} gateId=${gateId}`);
      }
    }

    // 标记事件已提交
    gate.markEventsCommitted();
  }

  /** 注册 RiskSummaryReady 事件监听（由 AppModule 或 SPI 默认实现调用） */
  registerListeners(): void {
    this.emitter.on(OR_EVENT_TYPES.RISK_SUMMARY_READY, async (event: RiskSummaryReadyEvent) => {
      await this.handleRiskSummaryReady(event);
    });
    this.logger.log('Registered RiskSummaryReady listener on OrchestratorBridgeService');
  }

  /**
   * 处理 PL 域门禁裁决事件（GatePassed / GateBlocked），回调 OR 的 AgentDispatcherService.onGateResult()。
   * 通过 runId 查找对应的 TaskPlan，然后调用 dispatcher.onGateResult(taskPlanId)。
   */
  private async handleGateResultEvent(
    eventType: string,
    event: DomainEvent<unknown>,
  ): Promise<void> {
    const payload = event.payload as Record<string, unknown> | undefined;
    if (!payload?.runId) {
      this.logger.warn(`Gate event missing runId: ${eventType} aggregateId=${event.aggregateId}`);
      return;
    }
    const runId = String(payload.runId);
    const plan = await this.planRepo.loadByRun(runId);
    if (!plan) {
      this.logger.warn(`No TaskPlan found for runId=${runId}, skipping gate result bridge`);
      return;
    }
    this.logger.log(`Bridging gate event ${eventType} → onGateResult(taskPlanId=${plan.taskPlanId})`);
    await this.dispatcher.onGateResult(plan.taskPlanId);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 辅助函数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 将 RiskLevel 映射为数值型风险分（用于 GateAggregate.riskScore）。
 * G1=10, G2=30, G3=70, G4=100（线性映射，便于阈值比较）。
 */
function computeRiskScore(riskLevel: RiskLevel): number {
  const scoreMap: Record<RiskLevel, number> = { G1: 10, G2: 30, G3: 70, G4: 100 };
  return scoreMap[riskLevel] ?? 50;
}

/**
 * 创建默认 PipelineEventContext stub。
 * 生产环境应注入基于 ulid + 请求 trace 的真实实现。
 */
function createStubEventContext() {
  return {
    nextEventId: () => `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    now: () => new Date().toISOString(),
    traceId: 'bridge-stub',
    spanId: 'bridge-stub-span',
  };
}

/** 供外部（如测试、WebhookController）直接调用的便捷方法 */
export function isGatePassedPayload(payload: unknown): payload is Record<string, unknown> & { decision: 'auto' | 'hitl' } {
  if (!payload || typeof payload !== 'object') return false;
  return 'decision' in payload && (payload.decision === 'auto' || payload.decision === 'hitl');
}
