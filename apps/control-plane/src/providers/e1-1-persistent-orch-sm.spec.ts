/**
 * E1-1: PersistentOrchestrationStateMachine 单元测试
 *
 * 覆盖：
 * - serialize/deserialize：快照序列化与反序列化
 * - replay：从事件列表回放状态迁移
 * - reset：测试隔离
 * - 非法迁移拒绝（边界守护）
 */
import { PersistentOrchestrationStateMachine } from './persistent-orch-state-machine';

describe('E1-1 PersistentOrchestrationStateMachine', () => {
  let sm: PersistentOrchestrationStateMachine;

  beforeEach(() => {
    sm = new PersistentOrchestrationStateMachine();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // serialize / deserialize
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('serialize captures current state and history', () => {
    sm.transition('PlanAutoLowRisk');
    sm.transition('AllAgentsDispatched');

    const snapshot = sm.serialize();

    expect(snapshot.state).toBe('AwaitingAgents');
    expect(snapshot.history).toHaveLength(2);
    expect(snapshot.history[0].trigger).toBe('PlanAutoLowRisk');
    expect(snapshot.history[1].trigger).toBe('AllAgentsDispatched');
    expect(snapshot.snapshotAt).toBeTruthy();
  });

  it('deserialize restores state from snapshot', () => {
    sm.transition('PlanAutoLowRisk');
    sm.transition('AllAgentsDispatched');

    const snapshot = sm.serialize();

    // 重置状态机
    sm.reset();
    expect(sm.current).toBe('Planning');

    // 从快照恢复
    sm.deserialize(snapshot);
    expect(sm.current).toBe('AwaitingAgents');
    expect(sm.getHistory()).toHaveLength(2);
  });

  it('deserialize with invalid state throws', () => {
    expect(() => sm.deserialize({ state: 'InvalidState', history: [], snapshotAt: '' })).toThrow(
      'Invalid state in snapshot',
    );
  });

  it('deserialize with null state throws', () => {
    expect(() => sm.deserialize({ state: null as any, history: [], snapshotAt: '' })).toThrow(
      'Invalid state in snapshot',
    );
  });

  it('round-trip: serialize → deserialize preserves full history', () => {
    sm.transition('PlanAutoLowRisk');
    sm.transition('AllAgentsDispatched');
    sm.transition('AllAgentsConcluded');
    sm.transition('RiskSummaryPublished');

    const snapshot = sm.serialize();
    sm.reset();
    sm.deserialize(snapshot);

    expect(sm.current).toBe('AwaitingGateResult');
    expect(sm.getHistory()).toHaveLength(4);
    expect(sm.getHistory()[0].from).toBe('Planning');
    expect(sm.getHistory()[0].to).toBe('Dispatching');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // replay
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('replay advances state through valid event sequence', () => {
    const events = [
      { eventType: 'or.plan.auto-low-risk' },
      { eventType: 'or.all-agents-dispatched' },
      { eventType: 'or.all-agents-concluded' },
      { eventType: 'or.risk.summary.ready' },
      { eventType: 'or.gate-result-received' },
    ];

    const applied = sm.replay(events);
    expect(applied).toBe(5);
    expect(sm.current).toBe('Done');
  });

  it('replay ignores irrelevant events', () => {
    const events = [
      { eventType: 'irrelevant.event' },
      { eventType: 'or.plan.auto-low-risk' },
      { eventType: 'another.irrelevant' },
    ];

    const applied = sm.replay(events);
    expect(applied).toBe(1);
    expect(sm.current).toBe('Dispatching');
  });

  it('replay partial sequence stops at intermediate state', () => {
    const events = [
      { eventType: 'or.plan.auto-low-risk' },
      { eventType: 'or.all-agents-dispatched' },
      // 只回放 2 个事件
    ];

    const applied = sm.replay(events);
    expect(applied).toBe(2);
    expect(sm.current).toBe('AwaitingAgents');
  });

  it('replay with out-of-order events ignores invalid transitions', () => {
    // 直接从 Planning 尝试 AllAgentsDispatched → 应被忽略
    const events = [
      { eventType: 'or.all-agents-dispatched' },
      { eventType: 'or.plan.auto-low-risk' },
      { eventType: 'or.all-agents-dispatched' },
    ];

    const applied = sm.replay(events);
    // 只有第 2、3 个事件有效
    expect(applied).toBe(2);
    expect(sm.current).toBe('AwaitingAgents');
  });

  it('replay full pipeline end-to-end', () => {
    const events = [
      { eventType: 'or.plan.auto-low-risk' },
      { eventType: 'or.all-agents-dispatched' },
      { eventType: 'or.all-agents-concluded' },
      { eventType: 'or.risk.summary.ready' },
      { eventType: 'or.gate-result-received' },
    ];

    sm.replay(events);
    expect(sm.isTerminal).toBe(true);
    expect(sm.current).toBe('Done');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // reset
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('reset restores to initial Planning state with empty history', () => {
    sm.transition('PlanAutoLowRisk');
    sm.transition('AllAgentsDispatched');
    sm.reset();

    expect(sm.current).toBe('Planning');
    expect(sm.getHistory()).toHaveLength(0);
    expect(sm.isTerminal).toBe(false);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 边界守护：非法迁移拒绝
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('rejects illegal transition from Planning to Done', () => {
    expect(() => sm.transition('GateResultReceived')).toThrow(
      'Illegal orchestration transition',
    );
  });

  it('rejects illegal transition from Planning to ConclusionsAggregated', () => {
    expect(() => sm.transition('AllAgentsConcluded')).toThrow(
      'Illegal orchestration transition',
    );
  });

  it('accepts valid transition from Planning to Dispatching', () => {
    expect(sm.transition('PlanAutoLowRisk')).toBe('Dispatching');
  });

  it('terminal state Done rejects further transitions', () => {
    sm.replay([
      { eventType: 'or.plan.auto-low-risk' },
      { eventType: 'or.all-agents-dispatched' },
      { eventType: 'or.all-agents-concluded' },
      { eventType: 'or.risk.summary.ready' },
      { eventType: 'or.gate-result-received' },
    ]);
    expect(sm.isTerminal).toBe(true);
    expect(() => sm.transition('PlanAutoLowRisk')).toThrow('Illegal orchestration transition');
  });
});
