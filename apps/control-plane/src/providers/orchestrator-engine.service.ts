/**
 * OrchestratorEngineService —— E1-2 RunAggregate ↔ OR FSM 双向联动
 *
 * 职责：
 * - 协调 OrchestrationStateMachine（OR 域）与 RunAggregate（PL 域）的状态同步
 * - 当 OR FSM 推进时，触发 Run 的 stage 推进（通过 EventBus 事件）
 * - 当 Run 完成 gate 阶段后，通知 OR FSM 进入 Done
 * - 提供状态快照序列化/反序列化，支持服务重启恢复
 *
 * 边界铁律（DES-13.9）：
 * - OR 不直接修改 PL 聚合根；通过领域事件传递状态变更
 * - RunAggregate.stage 唯一写者是 PL 域
 * - 本服务是事件桥接层，不做跨域状态直接操作
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import type { Run, RunStage } from '@aegisci/shared/types';
import {
  OrchestrationStateMachine,
  type OrchestrationState,
  TERMINAL_STATES,
} from '@aegisci/domain/orchestration';
import type { RunAggregate } from '@aegisci/domain/pipeline';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 联动上下文
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface LinkageContext {
  runId: string;
  taskPlanId: string;
  tenantId: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 状态同步事件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface OrToRunSyncEvent {
  runId: string;
  targetStage: RunStage;
  reason: string;
}

export interface RunToOrSyncEvent {
  runId: string;
  taskPlanId: string;
  stage: RunStage;
  status: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 事件发布端口（由控制面注入）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const ORCHESTRATOR_LINKAGE_EVENT_BUS = Symbol('ORCHESTRATOR_LINKAGE_EVENT_BUS');

export interface OrchestratorLinkageEventBus {
  publishOrToRun(event: OrToRunSyncEvent): Promise<void>;
  publishRunToOr(event: RunToOrSyncEvent): Promise<void>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 仓储端口
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const OR_STATE_MACHINE_REPOSITORY = Symbol('OR_STATE_MACHINE_REPOSITORY');

export interface OrStateMachineRepository {
  saveSnapshot(runId: string, state: OrchestrationState, history: Array<{ from: string; to: string; trigger: string; at: string }>): Promise<void>;
  loadSnapshot(runId: string): Promise<{ state: OrchestrationState; history: Array<{ from: string; to: string; trigger: string; at: string }> } | null>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 引擎服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class OrchestratorEngineService {
  private readonly logger = new Logger(OrchestratorEngineService.name);

  constructor(
    @Inject(ORCHESTRATOR_LINKAGE_EVENT_BUS)
    private readonly eventBus: OrchestratorLinkageEventBus,
    @Inject(OR_STATE_MACHINE_REPOSITORY)
    private readonly stateRepo: OrStateMachineRepository,
  ) {}

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // OR FSM 生命周期
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 为指定 run 创建新的 OR FSM 实例，并持久化初始快照。
   */
  async createAndPersist(runId: string, initialStage: RunStage): Promise<OrchestrationStateMachine> {
    const sm = new OrchestrationStateMachine();
    // 初始快照：Planning 状态
    await this.stateRepo.saveSnapshot(runId, 'Planning', []);
    this.logger.log(`OR FSM created and persisted for run=${runId} initialStage=${initialStage}`);
    return sm;
  }

  /**
   * 从持久化快照恢复 FSM（服务重启场景）。
   * @returns 恢复的 FSM，若无可恢复快照则返回 null
   */
  async rehydrate(runId: string): Promise<OrchestrationStateMachine | null> {
    const snapshot = await this.stateRepo.loadSnapshot(runId);
    if (!snapshot) return null;

    const sm = new OrchestrationStateMachine();
    // 直接设置状态（跳过迁移校验，因为是恢复场景）
    sm['state'] = snapshot.state;
    sm['history'] = snapshot.history;
    this.logger.log(`OR FSM rehydrated for run=${runId} state=${snapshot.state}`);
    return sm;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // E1-2: OR → Run 联动（OR FSM 推进时触发 Run stage 变化）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * OR FSM 从 Planning → Dispatching 时，通知 PL 将 Run 推进到 dispatching stage。
   * 通过 eventBus 发布 OrToRunSyncEvent，由 PL 侧消费并推进 RunAggregate。
   */
  async onOrDispatching(runId: string, taskPlanId: string): Promise<void> {
    const event: OrToRunSyncEvent = {
      runId,
      targetStage: 'dispatching',
      reason: `OR FSM → Dispatching (taskPlan=${taskPlanId})`,
    };
    await this.eventBus.publishOrToRun(event);
    this.logger.log(`OR→Run sync: run=${runId} targetStage=dispatching`);
  }

  /**
   * OR FSM 从 Dispatching → AwaitingAgents 时，通知 PL 将 Run 推进到 reviewing stage。
   */
  async onOrAwaitingAgents(runId: string, taskPlanId: string): Promise<void> {
    const event: OrToRunSyncEvent = {
      runId,
      targetStage: 'reviewing',
      reason: `OR FSM → AwaitingAgents (taskPlan=${taskPlanId})`,
    };
    await this.eventBus.publishOrToRun(event);
    this.logger.log(`OR→Run sync: run=${runId} targetStage=reviewing`);
  }

  /**
   * OR FSM 从 AwaitingAgents → ConclusionsAggregated 时，通知 PL 进入 gate 评估。
   */
  async onOrConclusionsAggregated(runId: string, taskPlanId: string): Promise<void> {
    const event: OrToRunSyncEvent = {
      runId,
      targetStage: 'reviewing', // 保持 reviewing，等待 gate 裁决
      reason: `OR FSM → ConclusionsAggregated, riskSummary published (taskPlan=${taskPlanId})`,
    };
    await this.eventBus.publishOrToRun(event);
    this.logger.log(`OR→Run sync: run=${runId} conclusions aggregated`);
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // E1-2: Run → OR 联动（Run gate 完成后通知 OR FSM 进入 Done）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 接收 PL 侧 Run 完成 gate 后的通知，推进 OR FSM 到 Done。
   * 由 RunToOrSyncEvent 消费触发。
   */
  async onRunGateCompleted(runId: string, taskPlanId: string, gateStatus: 'passed' | 'blocked'): Promise<boolean> {
    // 恢复 FSM
    const sm = await this.rehydrate(runId);
    if (!sm) {
      this.logger.warn(`No OR FSM found for run=${runId}, skipping gate completion sync`);
      return false;
    }

    if (sm.current === 'AwaitingGateResult') {
      sm.onGateResultReceived();
      await this.stateRepo.saveSnapshot(runId, sm.current, sm.getHistory());
      this.logger.log(`OR FSM → Done (gate=${gateStatus}) run=${runId}`);
      return true;
    }

    this.logger.warn(`OR FSM not in AwaitingGateResult state: run=${runId} current=${sm.current}`);
    return false;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // E1-2: 状态一致性验证
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 验证 OR FSM 与 Run 状态的一致性。
   * - OR Done ↔ Run completed/gate_passed/gate_blocked
   * - OR AwaitingGateResult ↔ Run reviewing
   * - OR Dispatching/AwaitingAgents/ConclusionsAggregated ↔ Run dispatching/reviewing
   *
   * @returns 一致性问题列表（空数组表示一致）
   */
  async verifyConsistency(runId: string, orState: OrchestrationState, runStatus: string, runStage: RunStage): Promise<string[]> {
    const issues: string[] = [];

    const mappings: Array<{ orState: OrchestrationState; validRunStates: string[]; validRunStages: RunStage[] }> = [
      { orState: 'Planning', validRunStates: ['pending'], validRunStages: ['trigger'] },
      { orState: 'Dispatching', validRunStates: ['dispatching', 'reviewing'], validRunStages: ['dispatching', 'reviewing'] },
      { orState: 'AwaitingAgents', validRunStates: ['dispatching', 'reviewing'], validRunStages: ['dispatching', 'reviewing'] },
      { orState: 'ConclusionsAggregated', validRunStates: ['reviewing'], validRunStages: ['reviewing'] },
      { orState: 'AwaitingGateResult', validRunStates: ['reviewing'], validRunStages: ['reviewing'] },
      { orState: 'Done', validRunStates: ['completed', 'gate_passed', 'gate_blocked', 'failed', 'cancelled'], validRunStages: ['dispatching', 'reviewing', 'deploying'] },
    ];

    const mapping = mappings.find((m) => m.orState === orState);
    if (!mapping) {
      issues.push(`Unknown OR state: ${orState}`);
      return issues;
    }

    if (!mapping.validRunStates.includes(runStatus)) {
      issues.push(
        `OR=${orState} but Run.status=${runStatus} (expected one of: ${mapping.validRunStates.join(', ')})`,
      );
    }

    if (!mapping.validRunStages.includes(runStage)) {
      issues.push(
        `OR=${orState} but Run.stage=${runStage} (expected one of: ${mapping.validRunStages.join(', ')})`,
      );
    }

    return issues;
  }

  /**
   * 检查 OR FSM 是否处于终态。
   */
  isTerminal(state: OrchestrationState): boolean {
    return TERMINAL_STATES.has(state);
  }

  /**
   * 获取合法迁移目标列表。
   */
  getValidTransitions(state: OrchestrationState): OrchestrationState[] {
    const { ORCHESTRATION_TRANSITIONS } = require('@aegisci/domain/orchestration');
    return (ORCHESTRATION_TRANSITIONS as any)[state] ?? [];
  }
}
