/**
 * E1-3: FSM 边界不变量守护测试
 *
 * 覆盖：
 * - 非法迁移拒绝测试（铁律：状态机不允许越级迁移）
 * - 终态不可逆（Done 后任何迁移被拒绝）
 * - 状态持久化一致性（快照序列化 → 反序列化 → 状态等价）
 * - 事件回放幂等性（重复回放相同事件序列，结果一致）
 */
import { OrchestrationStateMachine } from '@aegisci/domain/orchestration';
import { PersistentOrchestrationStateMachine } from './persistent-orch-state-machine';

describe('E1-3 FSM 边界不变量守护', () => {
  let sm: OrchestrationStateMachine;
  let persistentSm: PersistentOrchestrationStateMachine;

  beforeEach(() => {
    sm = new OrchestrationStateMachine();
    persistentSm = new PersistentOrchestrationStateMachine();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 非法迁移拒绝测试
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('rejects Planning → Done (skip all intermediate states)', () => {
    expect(() => sm.transition('GateResultReceived')).toThrow('Illegal orchestration transition');
  });

  it('rejects Planning → AwaitingAgents (skip Dispatching)', () => {
    expect(() => sm.transition('AllAgentsConcluded')).toThrow('Illegal orchestration transition');
  });

  it('rejects Planning → ConclusionsAggregated', () => {
    expect(() => sm.transition('AllAgentsConcluded')).toThrow('Illegal orchestration transition');
  });

  it('rejects Dispatching → AwaitingGateResult (skip AwaitingAgents)', () => {
    sm.transition('PlanAutoLowRisk');
    expect(() => sm.transition('RiskSummaryPublished')).toThrow('Illegal orchestration transition');
  });

  it('rejects AwaitingAgents → Done (skip ConclusionsAggregated/AwaitingGateResult)', () => {
    sm.transition('PlanAutoLowRisk');
    sm.transition('AllAgentsDispatched');
    expect(() => sm.transition('GateResultReceived')).toThrow('Illegal orchestration transition');
  });

  it('rejects concurrent migration attempts (state integrity)', () => {
    const originalState = sm.current;
    sm.transition('PlanAutoLowRisk');
    // 不能从 Dispatching 再次 transition PlanAutoLowRisk
    expect(() => sm.transition('PlanAutoLowRisk')).toThrow('Illegal orchestration transition');
    // 状态未改变
    expect(sm.current).toBe('Dispatching');
    expect(sm.current).toBe(originalState === 'Planning' ? 'Dispatching' : originalState);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 终态不可逆
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('Done state rejects any further transitions', () => {
    sm.transition('PlanAutoLowRisk');
    sm.transition('AllAgentsDispatched');
    sm.transition('AllAgentsConcluded');
    sm.transition('RiskSummaryPublished');
    sm.transition('GateResultReceived');

    expect(sm.isTerminal).toBe(true);
    expect(sm.current).toBe('Done');

    // 所有迁移都被拒绝
    expect(() => sm.transition('PlanAutoLowRisk')).toThrow('Illegal orchestration transition');
    expect(() => sm.transition('AllAgentsDispatched')).toThrow('Illegal orchestration transition');
    expect(() => sm.transition('GateResultReceived')).toThrow('Illegal orchestration transition');
  });

  it('terminal state history is complete', () => {
    sm.transition('PlanAutoLowRisk');
    sm.transition('AllAgentsDispatched');
    sm.transition('AllAgentsConcluded');
    sm.transition('RiskSummaryPublished');
    sm.transition('GateResultReceived');

    const history = sm.getHistory();
    expect(history).toHaveLength(5);
    expect(history[0].trigger).toBe('PlanAutoLowRisk');
    expect(history[4].trigger).toBe('GateResultReceived');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 状态持久化一致性
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('serialize/deserialize preserves full state chain', () => {
    persistentSm.transition('PlanAutoLowRisk');
    persistentSm.transition('AllAgentsDispatched');
    persistentSm.transition('AllAgentsConcluded');
    persistentSm.transition('RiskSummaryPublished');

    const snapshot = persistentSm.serialize();
    persistentSm.reset();
    persistentSm.deserialize(snapshot);

    expect(persistentSm.current).toBe('AwaitingGateResult');
    expect(persistentSm.getHistory()).toHaveLength(4);
  });

  it('rehydration maintains transition validity after deserialize', () => {
    persistentSm.transition('PlanAutoLowRisk');
    persistentSm.transition('AllAgentsDispatched');

    const snapshot = persistentSm.serialize();
    persistentSm.reset();
    persistentSm.deserialize(snapshot);

    // 恢复后应能继续合法迁移
    persistentSm.transition('AllAgentsConcluded');
    expect(persistentSm.current).toBe('ConclusionsAggregated');
  });

  it('snapshot is defensive copy (mutation does not affect original)', () => {
    persistentSm.transition('PlanAutoLowRisk');
    const snapshot1 = persistentSm.serialize();
    persistentSm.transition('AllAgentsDispatched');

    // 修改快照不应影响已持久化的状态
    snapshot1.state = 'Invalid';
    expect(persistentSm.current).toBe('AwaitingAgents');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 事件回放幂等性
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('replay same events twice produces identical final state', () => {
    const events = [
      { eventType: 'or.plan.auto-low-risk' },
      { eventType: 'or.all-agents-dispatched' },
      { eventType: 'or.all-agents-concluded' },
      { eventType: 'or.risk.summary.ready' },
      { eventType: 'or.gate-result-received' },
    ];

    persistentSm.replay(events);
    const state1 = persistentSm.serialize();

    persistentSm.reset();
    persistentSm.replay(events);
    const state2 = persistentSm.serialize();

    expect(state2.state).toBe(state1.state);
    expect(state2.history.length).toBe(state1.history.length);
  });

  it('replay with extra irrelevant events is idempotent', () => {
    const coreEvents = [
      { eventType: 'or.plan.auto-low-risk' },
      { eventType: 'or.all-agents-dispatched' },
    ];
    const noisyEvents = [
      { eventType: 'or.plan.auto-low-risk' },
      { eventType: 'irrelevant.event' },
      { eventType: 'or.all-agents-dispatched' },
      { eventType: 'another.noise' },
    ];

    persistentSm.replay(coreEvents);
    const state1 = persistentSm.serialize();

    persistentSm.reset();
    persistentSm.replay(noisyEvents);
    const state2 = persistentSm.serialize();

    expect(state2.state).toBe(state1.state);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 状态机不变量守护
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('current state is always a valid orchestration state', () => {
    const validStates = ['Planning', 'Dispatching', 'AwaitingAgents', 'ConclusionsAggregated', 'AwaitingGateResult', 'Done'];
    expect(validStates).toContain(sm.current);

    sm.transition('PlanAutoLowRisk');
    expect(validStates).toContain(sm.current);
  });

  it('canTransition reflects actual transition table', () => {
    expect(sm.canTransition('Dispatching')).toBe(true);
    expect(sm.canTransition('Done')).toBe(false);
    expect(sm.canTransition('AwaitingAgents')).toBe(false);

    sm.transition('PlanAutoLowRisk');
    expect(sm.canTransition('AwaitingAgents')).toBe(true);
    expect(sm.canTransition('Done')).toBe(false);
  });

  it('moveTo also validates against transition table', () => {
    expect(() => persistentSm.moveTo('Done')).toThrow('Illegal orchestration transition');
    persistentSm.moveTo('Dispatching');
    expect(persistentSm.current).toBe('Dispatching');
  });

  it('onAllAgentsConcluded only works from AwaitingAgents', () => {
    const mockEvent = { eventId: 'e1', eventType: 'or.agent.concluded', payload: {}, timestamp: '' } as any;
    expect(persistentSm.onAllAgentsConcluded(mockEvent)).toBe(false); // 从 Planning 开始

    persistentSm.transition('PlanAutoLowRisk');
    persistentSm.transition('AllAgentsDispatched');
    expect(persistentSm.onAllAgentsConcluded(mockEvent)).toBe(true);
  });

  it('onRiskSummaryPublished only works from ConclusionsAggregated', () => {
    const mockEvent = { eventId: 'e1', eventType: 'or.risk.summary.ready', payload: {}, timestamp: '' } as any;
    expect(persistentSm.onRiskSummaryPublished(mockEvent)).toBe(false);

    persistentSm.transition('PlanAutoLowRisk');
    persistentSm.transition('AllAgentsDispatched');
    persistentSm.transition('AllAgentsConcluded');
    expect(persistentSm.onRiskSummaryPublished(mockEvent)).toBe(true);
  });

  it('onGateResultReceived only works from AwaitingGateResult', () => {
    expect(persistentSm.onGateResultReceived()).toBe(false);

    persistentSm.transition('PlanAutoLowRisk');
    persistentSm.transition('AllAgentsDispatched');
    persistentSm.transition('AllAgentsConcluded');
    persistentSm.transition('RiskSummaryPublished');
    expect(persistentSm.onGateResultReceived()).toBe(true);
  });
});
