/**
 * E1-2: OrchestratorEngineService 单元测试
 *
 * 覆盖：
 * - createAndPersist / rehydrate：FSM 持久化与恢复
 * - onOrDispatching / onOrAwaitingAgents / onOrConclusionsAggregated：OR→Run 联动
 * - onRunGateCompleted：Run→OR 联动（gate 完成通知）
 * - verifyConsistency：状态一致性验证
 * - isTerminal：终态检测
 */
import { Test } from '@nestjs/testing';
import { OrchestratorEngineService, ORCHESTRATOR_LINKAGE_EVENT_BUS, OR_STATE_MACHINE_REPOSITORY } from './orchestrator-engine.service';
import { OrchestrationStateMachine } from '@aegisci/domain/orchestration';

describe('E1-2 OrchestratorEngineService', () => {
  let service: OrchestratorEngineService;
  let eventBus: { orToRun: any[]; runToOr: any[]; publishOrToRun: jest.Mock; publishRunToOr: jest.Mock };
  let stateRepo: { snapshots: Map<string, any>; saveSnapshot: jest.Mock; loadSnapshot: jest.Mock };

  beforeEach(async () => {
    eventBus = {
      orToRun: [],
      runToOr: [],
      publishOrToRun: jest.fn(async (event: any) => {
        eventBus.orToRun.push(event);
      }),
      publishRunToOr: jest.fn(async (event: any) => {
        eventBus.runToOr.push(event);
      }),
    };

    stateRepo = {
      snapshots: new Map<string, any>(),
      saveSnapshot: jest.fn(async (runId: string, state: string, history: any[]) => {
        stateRepo.snapshots.set(runId, { state, history });
      }),
      loadSnapshot: jest.fn(async (runId: string) => {
        return stateRepo.snapshots.get(runId) ?? null;
      }),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        OrchestratorEngineService,
        {
          provide: ORCHESTRATOR_LINKAGE_EVENT_BUS,
          useValue: eventBus,
        },
        {
          provide: OR_STATE_MACHINE_REPOSITORY,
          useValue: stateRepo,
        },
      ],
    }).compile();

    service = moduleRef.get<OrchestratorEngineService>(OrchestratorEngineService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // createAndPersist / rehydrate
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('createAndPersist saves initial Planning snapshot', async () => {
    const sm = await service.createAndPersist('run-1', 'trigger');

    expect(sm.current).toBe('Planning');
    expect(stateRepo.saveSnapshot).toHaveBeenCalledWith('run-1', 'Planning', []);
  });

  it('rehydrate restores FSM from snapshot', async () => {
    // 先保存一个中间状态
    await stateRepo.saveSnapshot('run-1', 'AwaitingAgents', [
      { from: 'Planning', to: 'Dispatching', trigger: 'PlanAutoLowRisk', at: 't1' },
      { from: 'Dispatching', to: 'AwaitingAgents', trigger: 'AllAgentsDispatched', at: 't2' },
    ]);

    const sm = await service.rehydrate('run-1');

    expect(sm).not.toBeNull();
    expect(sm!.current).toBe('AwaitingAgents');
  });

  it('rehydrate returns null when no snapshot exists', async () => {
    const sm = await service.rehydrate('run-missing');
    expect(sm).toBeNull();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // OR → Run 联动
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('onOrDispatching publishes OrToRunSyncEvent with dispatching stage', async () => {
    await service.onOrDispatching('run-1', 'tp-1');

    expect(eventBus.publishOrToRun).toHaveBeenCalledWith({
      runId: 'run-1',
      targetStage: 'dispatching',
      reason: expect.stringContaining('Dispatching'),
    });
  });

  it('onOrAwaitingAgents publishes OrToRunSyncEvent with reviewing stage', async () => {
    await service.onOrAwaitingAgents('run-1', 'tp-1');

    expect(eventBus.publishOrToRun).toHaveBeenCalledWith({
      runId: 'run-1',
      targetStage: 'reviewing',
      reason: expect.stringContaining('AwaitingAgents'),
    });
  });

  it('onOrConclusionsAggregated publishes OrToRunSyncEvent', async () => {
    await service.onOrConclusionsAggregated('run-1', 'tp-1');

    expect(eventBus.publishOrToRun).toHaveBeenCalledWith({
      runId: 'run-1',
      targetStage: 'reviewing',
      reason: expect.stringContaining('ConclusionsAggregated'),
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // Run → OR 联动
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('onRunGateCompleted advances FSM to Done when in AwaitingGateResult', async () => {
    // 先恢复到 AwaitingGateResult 状态
    await stateRepo.saveSnapshot('run-1', 'AwaitingGateResult', []);

    const result = await service.onRunGateCompleted('run-1', 'tp-1', 'passed');

    expect(result).toBe(true);
    const restored = await service.rehydrate('run-1');
    expect(restored!.current).toBe('Done');
  });

  it('onRunGateCompleted returns false when FSM not in AwaitingGateResult', async () => {
    await stateRepo.saveSnapshot('run-1', 'Planning', []);

    const result = await service.onRunGateCompleted('run-1', 'tp-1', 'passed');

    expect(result).toBe(false);
  });

  it('onRunGateCompleted logs warning when no FSM found', async () => {
    // 不保存快照，模拟 FSM 不存在
    const result = await service.onRunGateCompleted('run-missing', 'tp-missing', 'passed');

    expect(result).toBe(false);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // verifyConsistency
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('returns empty issues when OR and Run states are consistent', async () => {
    const issues = await service.verifyConsistency('run-1', 'Done', 'completed', 'deploying');
    expect(issues).toEqual([]);
  });

  it('returns issues when OR=Done but Run.status=reviewing', async () => {
    const issues = await service.verifyConsistency('run-1', 'Done', 'reviewing', 'reviewing');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('Run.status=reviewing');
  });

  it('returns issues when OR=AwaitingGateResult but Run.stage=dispatching', async () => {
    const issues = await service.verifyConsistency('run-1', 'AwaitingGateResult', 'reviewing', 'dispatching');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('Run.stage=dispatching');
  });

  it('handles unknown OR state gracefully', async () => {
    const issues = await service.verifyConsistency('run-1', 'UnknownState' as any, 'pending', 'trigger');
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toContain('Unknown OR state');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // isTerminal
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('isTerminal returns true for Done state', () => {
    expect(service.isTerminal('Done')).toBe(true);
  });

  it('isTerminal returns false for non-terminal states', () => {
    expect(service.isTerminal('Planning')).toBe(false);
    expect(service.isTerminal('Dispatching')).toBe(false);
    expect(service.isTerminal('AwaitingGateResult')).toBe(false);
  });
});
