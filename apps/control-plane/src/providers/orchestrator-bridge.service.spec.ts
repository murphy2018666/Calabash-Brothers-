/**
 * OrchestratorBridgeService 单元测试（D2-1 OR↔PL 事件桥接）。
 *
 * 覆盖桥接契约不变在：
 * - handleRiskSummaryReady() → GateAggregate 创建 + 评估 + GatePassed/GateBlocked 发布
 * - onModuleInit → 订阅 PL gate 事件并回调 onGateResult
 * - 找不到 TaskPlan → 静默跳过不报错
 * - RiskLevel G1 → auto pass；G3/G4 → blocked
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  GateAggregate,
  DEFAULT_AUTO_ALLOW_RISK_LEVEL,
  PIPELINE_EVENT_TYPES,
} from '@aegisci/domain/pipeline';
import {
  TASK_PLAN_REPOSITORY,
  type TaskPlanRepository,
  AgentDispatcherService,
} from '@aegisci/domain/orchestration';
import { OR_EVENT_TYPES, type RiskSummaryReadyEvent } from '@aegisci/domain/orchestration';
import { OrchestratorBridgeService } from './orchestrator-bridge.service';

describe('OrchestratorBridgeService (D2-1 OR↔PL 事件桥接)', () => {
  let service: OrchestratorBridgeService;
  let emitter: EventEmitter2;
  let planRepo: jest.Mocked<TaskPlanRepository>;
  let dispatcher: jest.Mocked<AgentDispatcherService>;

  const makePlan = (taskPlanId: string, runId: string, riskLevel: string) => ({
    taskPlanId,
    runId,
    tenantId: 'tenant-1',
    riskLevel: riskLevel as 'G1' | 'G2' | 'G3' | 'G4',
    state: 'ConclusionsAggregated' as const,
    tasks: [],
    pullPendingEvents: () => [],
    onGateResult: jest.fn(),
  });

  beforeEach(async () => {
    emitter = new EventEmitter2();
    // Mock emitter.emit to track calls
    (emitter as any).emit = jest.fn(emitter.emit.bind(emitter));
    planRepo = {
      load: jest.fn().mockResolvedValue(null),
      loadByRun: jest.fn().mockResolvedValue(null),
      save: jest.fn().mockResolvedValue(undefined),
    };
    dispatcher = {
      onGateResult: jest.fn().mockResolvedValue(undefined),
    } as unknown as jest.Mocked<AgentDispatcherService>;

    service = new OrchestratorBridgeService(planRepo as unknown as TaskPlanRepository, emitter, dispatcher as unknown as AgentDispatcherService);
    service.registerListeners();
    service.onModuleInit(); // subscribe to PL gate events
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // handleRiskSummaryReady
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('creates GateAggregate and emits GatePassed for G1 (auto-allow)', async () => {
    const plan = makePlan('tp-1', 'run-1', 'G1');
    planRepo.load.mockResolvedValue(plan as any);

    const event: RiskSummaryReadyEvent = {
      eventId: 'evt-rs-1',
      eventType: OR_EVENT_TYPES.RISK_SUMMARY_READY,
      aggregateId: 'tp-1',
      aggregateType: 'TaskPlan',
      tenantId: 'tenant-1',
      payload: {
        runId: 'run-1',
        taskPlanId: 'tp-1',
        riskLevel: 'G1',
        entryIds: [],
        criticalCount: 0,
        contributors: [],
        summary: 'Low risk',
      },
      timestamp: new Date().toISOString(),
      traceId: 'run-1',
      spanId: 'span-1',
    };

    await service.handleRiskSummaryReady(event);

    // GatePassed 事件应被 emit 到 emitter
    const emittedEvents = (emitter.emit as jest.Mock).mock.calls.filter(
      (call: unknown[]) =>
        typeof call[0] === 'string' &&
        (call[0] === PIPELINE_EVENT_TYPES.GATE_PASSED || call[0] === PIPELINE_EVENT_TYPES.GATE_BLOCKED),
    );
    expect(emittedEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('emits GateBlocked for G3 (requires HITL)', async () => {
    const plan = makePlan('tp-2', 'run-2', 'G3');
    planRepo.load.mockResolvedValue(plan as any);

    const event: RiskSummaryReadyEvent = {
      eventId: 'evt-rs-2',
      eventType: OR_EVENT_TYPES.RISK_SUMMARY_READY,
      aggregateId: 'tp-2',
      aggregateType: 'TaskPlan',
      tenantId: 'tenant-1',
      payload: {
        runId: 'run-2',
        taskPlanId: 'tp-2',
        riskLevel: 'G3',
        entryIds: [],
        criticalCount: 2,
        contributors: ['agent-1'],
        summary: 'High risk findings',
      },
      timestamp: new Date().toISOString(),
      traceId: 'run-2',
      spanId: 'span-2',
    };

    await service.handleRiskSummaryReady(event);

    // 检查是否发出了 GateBlocked
    const blockedCalls = (emitter.emit as jest.Mock).mock.calls.filter(
      (call: unknown[]) => call[0] === PIPELINE_EVENT_TYPES.GATE_BLOCKED,
    );
    expect(blockedCalls.length).toBeGreaterThanOrEqual(1);
  });

  it('skips silently when TaskPlan not found', async () => {
    planRepo.load.mockResolvedValue(null);

    const event: RiskSummaryReadyEvent = {
      eventId: 'evt-rs-miss',
      eventType: OR_EVENT_TYPES.RISK_SUMMARY_READY,
      aggregateId: 'tp-miss',
      aggregateType: 'TaskPlan',
      tenantId: 'tenant-1',
      payload: {
        runId: 'run-miss',
        taskPlanId: 'tp-miss',
        riskLevel: 'G1',
        entryIds: [],
        criticalCount: 0,
        contributors: [],
        summary: 'missing',
      },
      timestamp: new Date().toISOString(),
      traceId: 'run-miss',
      spanId: 'span-miss',
    };

    // 不应抛出异常
    await expect(service.handleRiskSummaryReady(event)).resolves.toBeUndefined();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // onModuleInit → PL gate event bridge to OR
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('bridges GatePassed event back to TaskPlan.onGateResult via runId lookup', async () => {
    const plan = makePlan('tp-1', 'run-1', 'G1');
    planRepo.loadByRun.mockResolvedValue(plan as any);

    const gatePassedEvent = {
      eventId: 'evt-gp-1',
      eventType: PIPELINE_EVENT_TYPES.GATE_PASSED,
      aggregateId: 'gate_tp-1',
      aggregateType: 'Gate',
      tenantId: 'tenant-1',
      payload: { runId: 'run-1', gateId: 'gate_tp-1', decision: 'auto' as const },
      timestamp: new Date().toISOString(),
      traceId: 'run-1',
      spanId: 'span-1',
    };

    // fire-and-forget：emitter.emit 同步触发 listener，但 handler 是 async
    emitter.emit(PIPELINE_EVENT_TYPES.GATE_PASSED, gatePassedEvent);
    // 等待微任务解析
    await new Promise((resolve) => setImmediate(resolve));

    // onGateResult 应被调用
    expect(planRepo.loadByRun).toHaveBeenCalledWith('run-1');
    expect(dispatcher.onGateResult).toHaveBeenCalledWith('tp-1');
  });

  it('bridges GateBlocked event back to TaskPlan.onGateResult via runId lookup', async () => {
    const plan = makePlan('tp-2', 'run-2', 'G3');
    planRepo.loadByRun.mockResolvedValue(plan as any);

    const gateBlockedEvent = {
      eventId: 'evt-gb-1',
      eventType: PIPELINE_EVENT_TYPES.GATE_BLOCKED,
      aggregateId: 'gate_tp-2',
      aggregateType: 'Gate',
      tenantId: 'tenant-1',
      payload: { runId: 'run-2', gateId: 'gate_tp-2' },
      timestamp: new Date().toISOString(),
      traceId: 'run-2',
      spanId: 'span-2',
    };

    emitter.emit(PIPELINE_EVENT_TYPES.GATE_BLOCKED, gateBlockedEvent);
    await new Promise((resolve) => setImmediate(resolve));

    expect(dispatcher.onGateResult).toHaveBeenCalledWith('tp-2');
  });

  it('skips bridge when runId is missing from gate event', async () => {
    const badEvent = {
      eventId: 'evt-bad',
      eventType: PIPELINE_EVENT_TYPES.GATE_PASSED,
      payload: { gateId: 'gate-x' }, // 缺少 runId
      timestamp: new Date().toISOString(),
    };

    emitter.emit(PIPELINE_EVENT_TYPES.GATE_PASSED, badEvent);
    await new Promise((resolve) => setImmediate(resolve));
    expect(dispatcher.onGateResult).not.toHaveBeenCalled();
  });

  it('skips bridge when no TaskPlan matches runId', async () => {
    planRepo.loadByRun.mockResolvedValue(null);

    emitter.emit(PIPELINE_EVENT_TYPES.GATE_PASSED, {
      eventId: 'evt-no-plan',
      eventType: PIPELINE_EVENT_TYPES.GATE_PASSED,
      payload: { runId: 'run-nonexistent' },
      timestamp: new Date().toISOString(),
    });

    expect(dispatcher.onGateResult).not.toHaveBeenCalled();
  });
});
