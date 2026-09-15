import { NatsEventBus } from './nats-event-bus';
import type { DomainEvent } from '@aegisci/shared/types';

describe('NatsEventBus (R2)', () => {
  let bus: NatsEventBus;

  beforeEach(() => {
    bus = new NatsEventBus();
  });

  afterEach(() => {
    bus.reset();
  });

  const makeEvent = (overrides: Partial<DomainEvent<unknown>> = {}): DomainEvent<unknown> => ({
    eventId: `e-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    eventType: 'pipeline.gate.passed',
    aggregateId: 'g1',
    aggregateType: 'Gate',
    tenantId: 't1',
    payload: {},
    timestamp: new Date().toISOString(),
    traceId: 'tr1',
    spanId: 's1',
    ...overrides,
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R2-1: 基本发布订阅
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R2-1-1: publish forwards event to exact-match subscriber', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.gate.passed', handler);
    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed' }));

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventType: 'pipeline.gate.passed' }));
  });

  it('R2-1-2: published count increases after publish', async () => {
    const event = makeEvent();
    await bus.publish(event);
    expect(bus.getPublishedCount()).toBe(1);
  });

  it('R2-1-3: healthy returns true when no issues', async () => {
    expect(await bus.healthy()).toBe(true);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R2-2: Wildcard 匹配
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R2-2-1: wildcard > matches all children subjects', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.>', handler);

    await bus.publish(makeEvent({ eventType: 'pipeline.run.created' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.gate.blocked' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.run.failed' }));

    expect(handler).toHaveBeenCalledTimes(3);
  });

  it('R2-2-2: wildcard * matches single segment', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.*.passed', handler);

    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.run.passed' }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('R2-2-3: wildcard * does not match multiple segments', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.*.passed', handler);

    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.orchestration.job.completed' }));

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('R2-2-4: nested wildcards work correctly', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.orchestration.>', handler);

    await bus.publish(makeEvent({ eventType: 'pipeline.orchestration.job.dispatched' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.orchestration.job.completed' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed' }));

    expect(handler).toHaveBeenCalledTimes(2);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R2-3: 事件路由去重
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R2-3-1: duplicate event is ignored', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.gate.passed', handler);

    const event = makeEvent({ eventType: 'pipeline.gate.passed', eventId: 'e-dup-1' });
    await bus.publish(event);
    await bus.publish(event); // duplicate

    expect(handler).toHaveBeenCalledTimes(1);
    expect(bus.getPublishedCount()).toBe(1);
  });

  it('R2-3-2: different events are not deduplicated', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.gate.passed', handler);

    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed', eventId: 'e-1' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed', eventId: 'e-2' }));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(bus.getPublishedCount()).toBe(2);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R2-4: 顺序保证
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R2-4-1: events are processed in order', async () => {
    const received: string[] = [];

    await bus.subscribe('pipeline.gate.passed', async (event) => {
      received.push(event.eventId);
    });

    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed', eventId: 'e-1' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed', eventId: 'e-2' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed', eventId: 'e-3' }));

    expect(received).toEqual(['e-1', 'e-2', 'e-3']);
  });

  it('R2-4-2: async handlers maintain order', async () => {
    const received: string[] = [];

    await bus.subscribe('pipeline.gate.passed', async (event) => {
      // 模拟异步处理
      await new Promise((resolve) => setTimeout(resolve, 10));
      received.push(event.eventId);
    });

    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed', eventId: 'e-1' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed', eventId: 'e-2' }));
    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed', eventId: 'e-3' }));

    expect(received).toEqual(['e-1', 'e-2', 'e-3']);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R2-5: unsubscribe
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R2-5-1: unsubscribe removes specific handler', async () => {
    const h1 = jest.fn();
    const h2 = jest.fn();

    await bus.subscribe('pipeline.gate.passed', h1);
    await bus.subscribe('pipeline.gate.passed', h2);
    await bus.unsubscribe('pipeline.gate.passed', h1);

    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed' }));

    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('R2-5-2: unsubscribe without handler clears all', async () => {
    const h1 = jest.fn();
    const h2 = jest.fn();

    await bus.subscribe('pipeline.gate.passed', h1);
    await bus.subscribe('pipeline.gate.passed', h2);
    await bus.unsubscribe('pipeline.gate.passed');

    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed' }));

    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('R2-5-3: unsubscribe non-existent subject is safe', async () => {
    await expect(bus.unsubscribe('pipeline.nonexistent')).resolves.toBeUndefined();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R2-6: 故障回退
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R2-6-1: event loss increases lostEventCount', async () => {
    const handler = jest.fn().mockImplementation(() => {
      throw new Error('Simulated NATS failure');
    });

    await bus.subscribe('pipeline.gate.passed', handler);
    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed' }));

    expect(bus.getLostEventCount()).toBe(1);
  });

  it('R2-6-2: healthy returns false when degraded and many losses', async () => {
    bus.enableDegradedMode();
    for (let i = 0; i < 101; i++) {
      await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed' }));
    }
    expect(await bus.healthy()).toBe(false);
  });

  it('R2-6-3: reset clears all state', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.gate.passed', handler);
    await bus.publish(makeEvent());

    bus.reset();

    expect(bus.getPublishedCount()).toBe(0);
    expect(bus.getLostEventCount()).toBe(0);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R2-7: 跨领域事件路由
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R2-7-1: publishes events across domain boundaries', async () => {
    const pipelineHandler = jest.fn();
    const orchestrationHandler = jest.fn();

    await bus.subscribe('pipeline.gate.passed', pipelineHandler);
    await bus.subscribe('orchestration.risk.summary.ready', orchestrationHandler);

    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed' }));
    await bus.publish(makeEvent({ eventType: 'orchestration.risk.summary.ready' }));

    expect(pipelineHandler).toHaveBeenCalledTimes(1);
    expect(orchestrationHandler).toHaveBeenCalledTimes(1);
  });

  it('R2-7-2: domain-specific wildcard routing', async () => {
    const pipelineHandler = jest.fn();
    const orchestrationHandler = jest.fn();

    await bus.subscribe('pipeline.>', pipelineHandler);
    await bus.subscribe('orchestration.>', orchestrationHandler);

    await bus.publish(makeEvent({ eventType: 'pipeline.gate.passed' }));
    await bus.publish(makeEvent({ eventType: 'orchestration.risk.summary.ready' }));

    expect(pipelineHandler).toHaveBeenCalledTimes(1);
    expect(orchestrationHandler).toHaveBeenCalledTimes(1);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R2-8: 性能基准
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R2-8-1: performance < 1ms per event', async () => {
    const iterations = 1000;
    const startTime = Date.now();

    for (let i = 0; i < iterations; i++) {
      await bus.publish(makeEvent({ eventType: 'pipeline.test.event', eventId: `e-${i}` }));
    }

    const duration = Date.now() - startTime;
    const avgMs = duration / iterations;

    expect(avgMs).toBeLessThan(1);
  });

  it('R2-8-2: can handle burst of events', async () => {
    const eventIds: string[] = [];

    await bus.subscribe('pipeline.burst.>', async (event) => {
      eventIds.push(event.eventId as string);
    });

    const burstCount = 100;
    for (let i = 0; i < burstCount; i++) {
      await bus.publish(makeEvent({ eventType: 'pipeline.burst.event', eventId: `burst-${i}` }));
    }

    expect(eventIds.length).toBe(burstCount);
    expect(bus.getPublishedCount()).toBe(burstCount);
  });
});
