import { Injectable, Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';
import type { GateRecord, GateRepositoryPort, RiskSummary } from '@aegisci/domain/pipeline';
import { GateAggregate, DEFAULT_AUTO_ALLOW_RISK_LEVEL } from '@aegisci/domain/pipeline';
import type { DomainEvent } from '@aegisci/shared/types';

/**
 * ProgressiveGateChain —— 递进门禁聚合（D3）。
 *
 * 实现递进式部署门禁：多阶段串行放行，前一个门禁通过后才开启下一个。
 *
 * 状态机：
 *   stages[0].open → evaluating → passed → stages[1].open → ... → stages[n-1].passed → all passed
 *   any stage: blocked → HITL → opened → next stage
 *
 * 不变式：
 * - PL 域 Gate 唯一所有方（铁律 2）
 * - 递进顺序：不允许跳段（stage-0 未通过则 stage-1 不 open）
 * - 级联放行：最后一个阶段 passed 后，总状态 = 'completed'
 */

export type GateChainState = 'pending' | 'active' | 'completed' | 'failed';

export interface StageGateSnapshot {
  stageIndex: number;
  gateId: string;
  state: 'open' | 'evaluating' | 'passed' | 'blocked' | 'opened';
  riskLevel: string;
  riskScore: number;
}

export interface ProgressiveGateChainInit {
  chainId: string;
  runId: string;
  tenantId: string;
  stages: Array<{
    stageIndex: number;
    stageName: string;
    riskSummary: RiskSummary;
  }>;
}

/**
 * ProgressiveGateChain —— 递进门禁链。
 *
 * 典型场景：
 * - stage-0: sandbox（低风险，自动放行）
 * - stage-1: staging（中风险，HITL 审批）
 * - stage-2: production（高风险，HITL 审批）
 *
 * 每个阶段持有独立的 GateAggregate，前一个阶段 passed 后才激活下一个。
 */
@Injectable()
export class ProgressiveGateChain {
  private readonly logger = new Logger(ProgressiveGateChain.name);
  private readonly _stages: GateAggregate[] = [];
  private _currentState: GateChainState = 'pending';
  private _currentStageIndex = 0;
  private readonly events: DomainEvent<unknown>[] = [];

  constructor(
    private readonly repo: GateRepositoryPort,
    private readonly eventsBus: EventEmitter2,
  ) {}

  /**
   * 初始化递进门禁链。
   * 只激活第一个阶段，其余阶段等待前置阶段通过。
   */
  async init(init: ProgressiveGateChainInit): Promise<void> {
    for (const stageDef of init.stages) {
      const gate = GateAggregate.open(stageDef.riskSummary, `gate-${stageDef.stageIndex}`, {
        now: () => new Date().toISOString(),
        nextEventId: () => `evt-${init.chainId}-${stageDef.stageIndex}-${Date.now()}`,
        tenantId: init.tenantId,
        traceId: '',
        spanId: '',
      });
      this._stages.push(gate);
    }
    // 空阶段直接完成
    if (this._stages.length === 0) {
      this._currentState = 'completed';
      return;
    }
    // 设为 active 后评估第一个阶段
    this._currentState = 'active';
    await this.evaluateNextStage();
    this.logger.log(
      `GateChain ${init.chainId} initialized with ${init.stages.length} stages`,
    );
  }

  /**
   * 评估当前待处理阶段（按顺序）。
   * 仅当当前阶段已 open 时才触发评估。
   */
  async evaluateNextStage(): Promise<void> {
    if (this._currentState !== 'active') return;
    const stage = this._stages[this._currentStageIndex];
    if (!stage || stage.state !== 'open') return;

    stage.evaluate(DEFAULT_AUTO_ALLOW_RISK_LEVEL);
    await this.repo.save(stage.snapshot);

    for (const evt of stage.uncommittedEvents) {
      this.events.push(evt);
      this.eventsBus.emit(evt.eventType, evt);
    }
    stage.markEventsCommitted();

    // 阶段通过后推进到下一个，如果已是最后一个则不改变索引
    if (stage.state === 'passed' || stage.state === 'opened') {
      if (this._currentStageIndex < this._stages.length - 1) {
        this._currentStageIndex++;
        await this.evaluateNextStage();
      }
    }
  }

  /**
   * HITL 审批通过（仅适用于当前 blocked 阶段）。
   * 审批完成后自动推进到下一个阶段。
   */
  async approve(htlTicketId: string, approvedBy: string): Promise<void> {
    const stage = this._stages[this._currentStageIndex];
    if (!stage) {
      throw new Error(`no active stage (index=${this._currentStageIndex}, total=${this._stages.length})`);
    }
    if (stage.state !== 'blocked') {
      throw new Error(`stage ${this._currentStageIndex} is not blocked (state=${stage.state})`);
    }

    stage.approve({ approvalTicketId: htlTicketId, approvedBy });
    await this.repo.save(stage.snapshot);

    for (const evt of stage.uncommittedEvents) {
      this.events.push(evt);
      this.eventsBus.emit(evt.eventType, evt);
    }
    stage.markEventsCommitted();

    // 审批通过后推进到下一个阶段
    if (this._currentStageIndex < this._stages.length - 1) {
      this._currentStageIndex++;
    }
    await this.evaluateNextStage();
  }

  /** 当前阶段索引 */
  get currentStageIndex(): number {
    return this._currentStageIndex;
  }

  /** 总阶段数 */
  get stageCount(): number {
    return this._stages.length;
  }

  /** 当前阶段 */
  get currentStage(): GateAggregate | null {
    return this._stages[this._currentStageIndex] ?? null;
  }

  /** 是否全部通过 */
  get isCompleted(): boolean {
    // 空阶段列表视为已完成
    if (this._stages.length === 0) return true;
    return this._stages.every((s) => s.state === 'passed' || s.state === 'opened');
  }

  /** 整体状态 */
  get state(): GateChainState {
    return this._currentState;
  }

  /** 所有阶段的快照 */
  getAllStages(): ReadonlyArray<Readonly<GateRecord>> {
    return this._stages.map((s) => s.snapshot);
  }

  /** 获取特定阶段的快照 */
  async getStageSnapshot(stageIndex: number): Promise<GateRecord | null> {
    const stage = this._stages[stageIndex];
    if (!stage) return null;
    return this.repo.load(stage.gateId);
  }

  /** 保存当前阶段快照（供外部持久化） */
  async persistCurrentStage(): Promise<void> {
    const stage = this._stages[this._currentStageIndex];
    if (stage) await this.repo.save(stage.snapshot);
  }
}
