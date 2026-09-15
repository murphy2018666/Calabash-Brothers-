/**
 * Orchestration (OR) 编排状态机
 *
 * 对应设计文档：
 * - ADD §5.2 Orchestration 状态机
 * - detailed-design §4.2 Orchestration 状态机
 *
 * 状态序列（本骨架覆盖主路径）：
 *   Planning → Dispatching → AwaitingAgents → ConclusionsAggregated
 *           → AwaitingGateResult → Done
 *
 * 双状态机唯一写者规则（铁律第 1 条）：
 * - 本状态机只描述 OR 自身编排状态（聚合根 TaskPlan/BlackboardSession）。
 * - Run 生命周期（Run.stage）与门禁（Gate）状态的唯一写者是 PL 域。
 * - OR 通过发布领域事件（RiskSummaryReady/ConclusionsAggregated）向 PL 传递事实，
 *   由 PL 按门禁策略推进 Run.stage 与 Gate 状态。
 * - OR 任何情况下不得直接修改 PL 聚合根，不得越过 PL 直接操作 Git 合并/部署。
 */
import type { AgentConcludedEvent, RiskSummaryReadyEvent } from './events/orchestration-events';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 状态定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const ORCHESTRATION_STATES = [
  'Planning', // 解析 PR 上下文 → 生成结构化 TaskPlan
  'Dispatching', // 分派 Agent（M1 默认 / M3 委托）
  'AwaitingAgents', // 等待各 Agent 追加结论到 Blackboard
  'ConclusionsAggregated', // 结论聚合完成 → 生成 riskSummary
  'AwaitingGateResult', // 已发布 RiskSummaryReady，等待 PL 门禁裁决事件
  'Done', // 收到 PL 的 GatePassed/GateBlocked 终结信号，编排结束
] as const;

export type OrchestrationState = (typeof ORCHESTRATION_STATES)[number];

export const TERMINAL_STATES: ReadonlySet<OrchestrationState> = new Set<OrchestrationState>(['Done']);

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 状态迁移定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 合法迁移表。任何不在表中的迁移将被拒绝（防止越级写状态）。
 * - Planning → Dispatching：PlanApproved / AutoLowRisk
 * - Dispatching → AwaitingAgents：所有 Agent dispatch 完成
 * - AwaitingAgents → ConclusionsAggregated：所有 Agent 结论收集齐
 * - ConclusionsAggregated → AwaitingGateResult：riskSummary 生成并发布 RiskSummaryReady
 * - AwaitingGateResult → Done：收到 PL 发布的 GatePassed/GateBlocked 事件
 */
export const ORCHESTRATION_TRANSITIONS: Readonly<Record<OrchestrationState, readonly OrchestrationState[]>> = {
  Planning: ['Dispatching'],
  Dispatching: ['AwaitingAgents'],
  AwaitingAgents: ['ConclusionsAggregated'],
  ConclusionsAggregated: ['AwaitingGateResult'],
  AwaitingGateResult: ['Done'],
  Done: [],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 迁移触发信号（与领域事件对齐）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type OrchestrationTrigger =
  | 'PlanApproved'
  | 'PlanAutoLowRisk'
  | 'AllAgentsDispatched'
  | 'AllAgentsConcluded'
  | 'RiskSummaryPublished'
  | 'GateResultReceived';

export const TRIGGER_TO_TRANSITION: Readonly<Record<OrchestrationTrigger, { from: OrchestrationState; to: OrchestrationState }>> = {
  PlanApproved: { from: 'Planning', to: 'Dispatching' },
  PlanAutoLowRisk: { from: 'Planning', to: 'Dispatching' },
  AllAgentsDispatched: { from: 'Dispatching', to: 'AwaitingAgents' },
  AllAgentsConcluded: { from: 'AwaitingAgents', to: 'ConclusionsAggregated' },
  RiskSummaryPublished: { from: 'ConclusionsAggregated', to: 'AwaitingGateResult' },
  GateResultReceived: { from: 'AwaitingGateResult', to: 'Done' },
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 状态机
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class OrchestrationStateMachine {
  private state: OrchestrationState = 'Planning';
  private readonly history: Array<{ from: OrchestrationState; to: OrchestrationState; trigger: OrchestrationTrigger; at: string }> = [];

  get current(): OrchestrationState {
    return this.state;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this.state);
  }

  canTransition(next: OrchestrationState): boolean {
    return ORCHESTRATION_TRANSITIONS[this.state].includes(next);
  }

  /** 校验并执行迁移；非法迁移抛错以保证状态机不变量。 */
  transition(trigger: OrchestrationTrigger): OrchestrationState {
    const rule = TRIGGER_TO_TRANSITION[trigger];
    if (!rule || rule.from !== this.state) {
      throw new Error(
        `Illegal orchestration transition: trigger=${trigger} from state=${this.state}`,
      );
    }
    const prev = this.state;
    this.state = rule.to;
    this.history.push({ from: prev, to: rule.to, trigger, at: new Date().toISOString() });
    return this.state;
  }

  /** 直接指定下一状态（仅当合法时）；用于事件驱动场景的事件回放。 */
  moveTo(next: OrchestrationState): void {
    if (!this.canTransition(next)) {
      throw new Error(`Illegal orchestration transition: ${this.state} → ${next}`);
    }
    this.state = next;
  }

  getHistory(): ReadonlyArray<{ from: OrchestrationState; to: OrchestrationState; trigger: OrchestrationTrigger; at: string }> {
    return this.history;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 事件驱动的便捷方法（与 OR 域事件语义对齐）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** 收齐所有 Agent 结论 → 推进到 ConclusionsAggregated */
  onAllAgentsConcluded(_event: AgentConcludedEvent): boolean {
    if (this.state === 'AwaitingAgents') {
      this.transition('AllAgentsConcluded');
      return true;
    }
    return false;
  }

  /** 发布 RiskSummaryReady → 推进到 AwaitingGateResult */
  onRiskSummaryPublished(_event: RiskSummaryReadyEvent): boolean {
    if (this.state === 'ConclusionsAggregated') {
      this.transition('RiskSummaryPublished');
      return true;
    }
    return false;
  }

  /** 收到 PL 的门禁结果事件 → 推进到 Done（终态） */
  onGateResultReceived(): boolean {
    if (this.state === 'AwaitingGateResult') {
      this.transition('GateResultReceived');
      return true;
    }
    return false;
  }
}
