/**
 * D2-5 PL↔OR 事件总线 NATS 集成测试。
 *
 * 覆盖：
 * - InMemoryNatsEventBus publish/subscribe/wildcard/unsubscribe/reset
 * - InMemoryConnectionGateway dispatchJob/cancelJob/healthy
 * - OrchestratorBridgeService 通过 EventBusPort 发布 PL 域事件（GatePassed/GateBlocked）
 * - GateController approve → GatePassed 事件经 EventBus 广播
 */
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  GateAggregate,
  DEFAULT_AUTO_ALLOW_RISK_LEVEL,
  PIPELINE_EVENT_TYPES,
  type EventBusPort,
  PIPELINE_TOKENS,
} from '@aegisci/domain/pipeline';
import {
  TASK_PLAN_REPOSITORY,
  type TaskPlanRepository,
  AgentDispatcherService,
} from '@aegisci/domain/orchestration';
import { OR_EVENT_TYPES, type RiskSummaryReadyEvent } from '@aegisci/domain/orchestration';
import { OrchestratorBridgeService } from './orchestrator-bridge.service';
import { InMemoryNatsEventBus } from './in-memory-nats-event-bus';
import { InMemoryConnectionGateway } from './in-memory-connection-gateway';
import type { ConnectionGatewayPort } from '@aegisci/domain/pipeline';

describe('D2-5 PL↔OR 事件总线 NATS 集成', () => {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // InMemoryNatsEventBus
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('InMemoryNatsEventBus', () => {
    let bus: InMemoryNatsEventBus;

    beforeEach(() => {
      bus = new InMemoryNatsEventBus();
    });

    it('publishes event and records in published array', async () => {
      const event = {
        eventId: 'e1',
        eventType: PIPELINE_EVENT_TYPES.GATE_PASSED,
        aggregateId: 'gate-1',
        aggregateType: 'Gate',
        tenantId: 't1',
        payload: { runId: 'r1', decision: 'auto' },
        timestamp: new Date().toISOString(),
        traceId: 'tr1',
        spanId: 's1',
      };
      await bus.publish(event as any);
      expect(bus.published).toHaveLength(1);
      expect(bus.published[0]).toBe(event);
    });

    it('subscribes and receives event', async () => {
      const handler = jest.fn();
      await bus.subscribe(PIPELINE_EVENT_TYPES.GATE_PASSED, handler);
      await bus.publish({
        eventId: 'e2', eventType: PIPELINE_EVENT_TYPES.GATE_PASSED,
        aggregateId: 'g2', aggregateType: 'Gate', tenantId: 't1',
        payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1',
      } as any);
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'e2' }));
    });

    it('wildcard > matches all children subjects', async () => {
      const handler = jest.fn();
      await bus.subscribe('pipeline.>', handler);
      await bus.publish({
        eventId: 'e3a', eventType: 'pipeline.run.created',
        aggregateId: 'r1', aggregateType: 'Run', tenantId: 't1',
        payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1',
      } as any);
      await bus.publish({
        eventId: 'e3b', eventType: 'pipeline.gate.blocked',
        aggregateId: 'g1', aggregateType: 'Gate', tenantId: 't1',
        payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1',
      } as any);
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it('wildcard * matches single segment', async () => {
      const handler = jest.fn();
      await bus.subscribe('pipeline.*.passed', handler);
      await bus.publish({
        eventId: 'e4', eventType: 'pipeline.gate.passed',
        aggregateId: 'g1', aggregateType: 'Gate', tenantId: 't1',
        payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1',
      } as any);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe removes specific handler', async () => {
      const h1 = jest.fn();
      const h2 = jest.fn();
      await bus.subscribe(PIPELINE_EVENT_TYPES.GATE_PASSED, h1);
      await bus.subscribe(PIPELINE_EVENT_TYPES.GATE_PASSED, h2);
      await bus.unsubscribe(PIPELINE_EVENT_TYPES.GATE_PASSED, h1);
      await bus.publish({
        eventId: 'e5', eventType: PIPELINE_EVENT_TYPES.GATE_PASSED,
        aggregateId: 'g1', aggregateType: 'Gate', tenantId: 't1',
        payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1',
      } as any);
      expect(h1).not.toHaveBeenCalled();
      expect(h2).toHaveBeenCalledTimes(1);
    });

    it('unsubscribe without handler clears all for subject', async () => {
      const h1 = jest.fn();
      const h2 = jest.fn();
      await bus.subscribe(PIPELINE_EVENT_TYPES.GATE_PASSED, h1);
      await bus.subscribe(PIPELINE_EVENT_TYPES.GATE_PASSED, h2);
      await bus.unsubscribe(PIPELINE_EVENT_TYPES.GATE_PASSED);
      await bus.publish({
        eventId: 'e6', eventType: PIPELINE_EVENT_TYPES.GATE_PASSED,
        aggregateId: 'g1', aggregateType: 'Gate', tenantId: 't1',
        payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1',
      } as any);
      expect(h1).not.toHaveBeenCalled();
      expect(h2).not.toHaveBeenCalled();
    });

    it('healthy returns true', async () => {
      expect(await bus.healthy()).toBe(true);
    });

    it('reset clears published events and handlers', async () => {
      const handler = jest.fn();
      await bus.subscribe(PIPELINE_EVENT_TYPES.GATE_PASSED, handler);
      await bus.publish({
        eventId: 'e7', eventType: PIPELINE_EVENT_TYPES.GATE_PASSED,
        aggregateId: 'g1', aggregateType: 'Gate', tenantId: 't1',
        payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1',
      } as any);
      expect(bus.published).toHaveLength(1);
      bus.reset();
      expect(bus.published).toHaveLength(0);
      expect(bus.getHandlers(PIPELINE_EVENT_TYPES.GATE_PASSED)).toHaveLength(0);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // InMemoryConnectionGateway
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('InMemoryConnectionGateway', () => {
    let gw: InMemoryConnectionGateway;

    beforeEach(() => {
      gw = new InMemoryConnectionGateway();
    });

    it('dispatchJob records the request', async () => {
      await gw.dispatchJob({ runId: 'r1', jobId: 'j1', attempt: 1, pool: 'default', spec: { cmd: 'test' } });
      expect(gw.dispatched).toHaveLength(1);
      expect(gw.dispatched[0].runId).toBe('r1');
      expect(gw.dispatched[0].jobId).toBe('j1');
    });

    it('cancelJob records the request', async () => {
      await gw.cancelJob({ runId: 'r1', jobId: 'j1', reason: 'timeout' });
      expect(gw.cancelled).toHaveLength(1);
      expect(gw.cancelled[0].reason).toBe('timeout');
    });

    it('healthy returns true', async () => {
      expect(await gw.healthy()).toBe(true);
    });

    it('reset clears all records', async () => {
      await gw.dispatchJob({ runId: 'r1', jobId: 'j1', attempt: 1, pool: 'p1', spec: {} });
      await gw.cancelJob({ runId: 'r1', jobId: 'j1', reason: 'kill' });
      expect(gw.dispatched).toHaveLength(1);
      expect(gw.cancelled).toHaveLength(1);
      gw.reset();
      expect(gw.dispatched).toHaveLength(0);
      expect(gw.cancelled).toHaveLength(0);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // OrchestratorBridgeService with EventBusPort
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('OrchestratorBridgeService with EventBusPort', () => {
    let service: OrchestratorBridgeService;
    let bus: InMemoryNatsEventBus;
    let planRepo: jest.Mocked<TaskPlanRepository>;
    let dispatcher: jest.Mocked<AgentDispatcherService>;
    let gw: InMemoryConnectionGateway;

    const makePlan = (taskPlanId: string, runId: string) => ({
      taskPlanId, runId, tenantId: 'tenant-1',
      state: 'ConclusionsAggregated' as const, tasks: [],
      pullPendingEvents: () => [],
      onGateResult: jest.fn(),
    });

    beforeEach(() => {
      bus = new InMemoryNatsEventBus();
      planRepo = {
        load: jest.fn().mockResolvedValue(null),
        loadByRun: jest.fn().mockResolvedValue(null),
        save: jest.fn().mockResolvedValue(undefined),
      };
      dispatcher = { onGateResult: jest.fn().mockResolvedValue(undefined) } as unknown as jest.Mocked<AgentDispatcherService>;
      gw = new InMemoryConnectionGateway();
      service = new OrchestratorBridgeService(
        planRepo as unknown as TaskPlanRepository,
        new EventEmitter2(),
        dispatcher as unknown as AgentDispatcherService,
      );
      // D2-5: 手动注入 EventBusPort（绕过 NestJS DI，用于测试）
      (service as any).eventBus = bus;
    });

    it('publishes GatePassed to EventBus when RiskSummaryReady G1 arrives', async () => {
      const plan = makePlan('tp-1', 'run-1');
      planRepo.load.mockResolvedValue(plan as any);

      const event: RiskSummaryReadyEvent = {
        eventId: 'evt-rs-1',
        eventType: OR_EVENT_TYPES.RISK_SUMMARY_READY,
        aggregateId: 'tp-1',
        aggregateType: 'TaskPlan',
        tenantId: 'tenant-1',
        payload: { runId: 'run-1', taskPlanId: 'tp-1', riskLevel: 'G1', entryIds: [], criticalCount: 0, contributors: [], summary: 'Low risk' },
        timestamp: new Date().toISOString(),
        traceId: 'run-1',
        spanId: 'span-1',
      };

      await service.handleRiskSummaryReady(event);

      const published = bus.published.filter((e) => e.eventType === PIPELINE_EVENT_TYPES.GATE_PASSED);
      expect(published.length).toBeGreaterThanOrEqual(1);
    });

    it('publishes GateBlocked to EventBus when RiskSummaryReady G3 arrives', async () => {
      const plan = makePlan('tp-2', 'run-2');
      planRepo.load.mockResolvedValue(plan as any);

      const event: RiskSummaryReadyEvent = {
        eventId: 'evt-rs-2',
        eventType: OR_EVENT_TYPES.RISK_SUMMARY_READY,
        aggregateId: 'tp-2',
        aggregateType: 'TaskPlan',
        tenantId: 'tenant-1',
        payload: { runId: 'run-2', taskPlanId: 'tp-2', riskLevel: 'G3', entryIds: [], criticalCount: 2, contributors: ['agent-1'], summary: 'High risk' },
        timestamp: new Date().toISOString(),
        traceId: 'run-2',
        spanId: 'span-2',
      };

      await service.handleRiskSummaryReady(event);

      const published = bus.published.filter((e) => e.eventType === PIPELINE_EVENT_TYPES.GATE_BLOCKED);
      expect(published.length).toBeGreaterThanOrEqual(1);
    });

    it('skips silently when TaskPlan not found', async () => {
      planRepo.load.mockResolvedValue(null);
      const event: RiskSummaryReadyEvent = {
        eventId: 'evt-miss', eventType: OR_EVENT_TYPES.RISK_SUMMARY_READY,
        aggregateId: 'tp-miss', aggregateType: 'TaskPlan', tenantId: 'tenant-1',
        payload: { runId: 'run-miss', taskPlanId: 'tp-miss', riskLevel: 'G1', entryIds: [], criticalCount: 0, contributors: [], summary: 'missing' },
        timestamp: new Date().toISOString(), traceId: 'run-miss', spanId: 'span-miss',
      };
      await expect(service.handleRiskSummaryReady(event)).resolves.toBeUndefined();
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GateAggregate → EventBus integration
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('GateAggregate + EventBus integration', () => {
    it('evaluate() emits events that can be published via EventBusPort', async () => {
      const bus = new InMemoryNatsEventBus();
      const gate = GateAggregate.open(
        { runId: 'run-x', tenantId: 't1', stage: 'review' as any, riskLevel: 'G2' as any, riskScore: 70, conclusions: [], generatedAt: new Date().toISOString() },
        'gate-x',
        { nextEventId: () => 'evt-1', now: () => new Date().toISOString(), traceId: 'tr1', spanId: 's1' },
      );
      gate.evaluate();
      expect(gate.state).toBe('blocked');

      // 将 uncommittedEvents 发布到 EventBus
      for (const evt of gate.uncommittedEvents) {
        await bus.publish(evt);
      }
      gate.markEventsCommitted();

      expect(bus.published.length).toBeGreaterThanOrEqual(1);
      expect(bus.published.some((e) => e.eventType === PIPELINE_EVENT_TYPES.GATE_BLOCKED)).toBe(true);
    });

    it('approve() emits GateOpened + GatePassed which can be published via EventBusPort', async () => {
      const bus = new InMemoryNatsEventBus();
      const gate = GateAggregate.open(
        { runId: 'run-hitl', tenantId: 't1', stage: 'review' as any, riskLevel: 'G3' as any, riskScore: 70, conclusions: [], generatedAt: new Date().toISOString() },
        'gate-hitl',
        { nextEventId: () => 'evt-h1', now: () => new Date().toISOString(), traceId: 'tr1', spanId: 's1' },
      );
      gate.evaluate(); // blocked
      gate.approve({ approvalTicketId: 'ticket-1', approvedBy: 'admin' }); // opened

      for (const evt of gate.uncommittedEvents) {
        await bus.publish(evt);
      }
      gate.markEventsCommitted();

      const types = bus.published.map((e) => e.eventType);
      expect(types).toContain(PIPELINE_EVENT_TYPES.GATE_BLOCKED);
      expect(types).toContain(PIPELINE_EVENT_TYPES.GATE_OPENED);
      expect(types).toContain(PIPELINE_EVENT_TYPES.GATE_PASSED);
    });
  });
});
