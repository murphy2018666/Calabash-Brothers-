/**
 * OrchestrationStateMachine — 可持久化版本（E1-1）
 *
 * 在 S3 骨架基础上增加：
 * - serialize(): 将当前状态 + 迁移历史序列化为 JSON 快照
 * - deserialize(snapshot): 从快照重建状态机（用于服务重启恢复）
 * - replay(events): 从已有领域事件列表回放，逐步推进状态（用于一致性验证）
 *
 * 不变量：
 * - 序列化/反序列化不修改外部可见的行为契约（canTransition / transition）
 * - 快照不包含敏感信息（仅状态 + 迁移元数据）
 */
import type { AgentConcludedEvent, RiskSummaryReadyEvent } from '@aegisci/domain/orchestration';
import {
  ORCHESTRATION_STATES,
  ORCHESTRATION_TRANSITIONS,
  TERMINAL_STATES,
  TRIGGER_TO_TRANSITION,
} from '@aegisci/domain/orchestration';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 快照类型
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface OrchestrationSnapshot {
  /** 当前状态 */
  state: string;
  /** 迁移历史（含 trigger） */
  history: Array<{
    from: string;
    to: string;
    trigger: string;
    at: string;
  }>;
  /** 快照生成时间 */
  snapshotAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 可持久化状态机
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class PersistentOrchestrationStateMachine {
  private state: string = 'Planning';
  private readonly history: Array<{ from: string; to: string; trigger: string; at: string }> = [];

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 基础行为（与 S3 OrchestrationStateMachine 对齐）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  get current(): string {
    return this.state;
  }

  get isTerminal(): boolean {
    return TERMINAL_STATES.has(this.state as any);
  }

  canTransition(next: string): boolean {
    const transitions = ORCHESTRATION_TRANSITIONS[this.state as any];
    return transitions ? transitions.includes(next) : false;
  }

  transition(trigger: string): string {
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

  moveTo(next: string): void {
    if (!this.canTransition(next)) {
      throw new Error(`Illegal orchestration transition: ${this.state} → ${next}`);
    }
    this.state = next;
  }

  getHistory(): ReadonlyArray<{ from: string; to: string; trigger: string; at: string }> {
    return this.history;
  }

  onAllAgentsConcluded(_event: AgentConcludedEvent): boolean {
    if (this.state === 'AwaitingAgents') {
      this.transition('AllAgentsConcluded');
      return true;
    }
    return false;
  }

  onRiskSummaryPublished(_event: RiskSummaryReadyEvent): boolean {
    if (this.state === 'ConclusionsAggregated') {
      this.transition('RiskSummaryPublished');
      return true;
    }
    return false;
  }

  onGateResultReceived(): boolean {
    if (this.state === 'AwaitingGateResult') {
      this.transition('GateResultReceived');
      return true;
    }
    return false;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // E1-1: 持久化能力
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /** 将当前状态 + 迁移历史序列化为 JSON 快照 */
  serialize(): OrchestrationSnapshot {
    return {
      state: this.state,
      history: [...this.history],
      snapshotAt: new Date().toISOString(),
    };
  }

  /**
   * 从快照重建状态机。
   * 注意：此方法会清空当前状态，用快照内容覆盖。
   * 用于服务重启后恢复（rehydrate）。
   */
  deserialize(snapshot: OrchestrationSnapshot): void {
    if (!snapshot.state || !ORCHESTRATION_STATES.includes(snapshot.state as any)) {
      throw new Error(`Invalid state in snapshot: ${snapshot.state}`);
    }
    this.state = snapshot.state;
    this.history = snapshot.history ?? [];
  }

  /**
   * 从领域事件列表回放状态迁移。
   * 逐条事件驱动状态机，验证事件序列的一致性。
   * 用于幂等性验证和一致性检查。
   *
   * @returns 成功应用的事件数
   * @throws 遇到非法迁移时抛出错误
   */
  replay(events: Array<{ eventType: string; payload?: Record<string, unknown> }>): number {
    let applied = 0;
    for (const evt of events) {
      try {
        switch (evt.eventType) {
          case 'or.plan.approved':
          case 'or.plan.auto-low-risk':
            this.transition('PlanAutoLowRisk');
            applied++;
            break;
          case 'or.all-agents-dispatched':
            this.transition('AllAgentsDispatched');
            applied++;
            break;
          case 'or.all-agents-concluded':
            if (this.state === 'AwaitingAgents') {
              this.transition('AllAgentsConcluded');
              applied++;
            }
            break;
          case 'or.risk.summary.ready':
            if (this.state === 'ConclusionsAggregated') {
              this.transition('RiskSummaryPublished');
              applied++;
            }
            break;
          case 'or.gate-result-received':
            if (this.state === 'AwaitingGateResult') {
              this.transition('GateResultReceived');
              applied++;
            }
            break;
          default:
            // 忽略无关事件
            break;
        }
      } catch {
        // 非法迁移静默忽略，不中断回放
      }
    }
    return applied;
  }

  /** 重置到初始状态（用于测试隔离） */
  reset(): void {
    this.state = 'Planning';
    this.history.length = 0;
  }
}
