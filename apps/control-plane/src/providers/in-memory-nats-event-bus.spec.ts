/**
 * InMemoryNatsEventBus 单元测试（D2-5 PL↔OR 事件总线集成）。
 */
import type { DomainEvent } from '@aegisci/shared/types';
import { InMemoryNatsEventBus } from './in-memory-nats-event-bus';

describe('InMemoryNatsEventBus (D2-5)', () => {
  let bus: InMemoryNatsEventBus;

  beforeEach(() => {
    bus = new InMemoryNatsEventBus();
  });

  it('publish forwards event to exact-match subscriber', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.gate.passed', handler);
    await bus.publish({
      eventId: 'e1',
      eventType: 'pipeline.gate.passed',
      aggregateId: 'g1',
      aggregateType: 'Gate',
      tenantId: 't1',
      payload: { runId: 'r1' },
      timestamp: new Date().toISOString(),
      traceId: 'tr1',
      spanId: 's1',
    } as DomainEvent<unknown>);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ eventId: 'e1' }));
    expect(bus.published).toHaveLength(1);
  });

  it('wildcard subject > matches all events', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.>', handler);
    await bus.publish({ eventId: 'e2', eventType: 'pipeline.run.created', aggregateId: 'r1', aggregateType: 'Run', tenantId: 't1', payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1' } as DomainEvent<unknown>);
    await bus.publish({ eventId: 'e3', eventType: 'pipeline.gate.blocked', aggregateId: 'g1', aggregateType: 'Gate', tenantId: 't1', payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1' } as DomainEvent<unknown>);
    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('wildcard subject * matches single segment', async () => {
    const handler = jest.fn();
    await bus.subscribe('pipeline.*.passed', handler);
    await bus.publish({ eventId: 'e4', eventType: 'pipeline.gate.passed', aggregateId: 'g1', aggregateType: 'Gate', tenantId: 't1', payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1' } as DomainEvent<unknown>);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe removes specific handler', async () => {
    const h1 = jest.fn();
    const h2 = jest.fn();
    await bus.subscribe('pipeline.gate.passed', h1);
    await bus.subscribe('pipeline.gate.passed', h2);
    await bus.unsubscribe('pipeline.gate.passed', h1);
    await bus.publish({ eventId: 'e5', eventType: 'pipeline.gate.passed', aggregateId: 'g1', aggregateType: 'Gate', tenantId: 't1', payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1' } as DomainEvent<unknown>);
    expect(h1).not.toHaveBeenCalled();
    expect(h2).toHaveBeenCalledTimes(1);
  });

  it('unsubscribe without handler clears all handlers for subject', async () => {
    const h1 = jest.fn();
    const h2 = jest.fn();
    await bus.subscribe('pipeline.gate.passed', h1);
    await bus.subscribe('pipeline.gate.passed', h2);
    await bus.unsubscribe('pipeline.gate.passed');
    await bus.publish({ eventId: 'e6', eventType: 'pipeline.gate.passed', aggregateId: 'g1', aggregateType: 'Gate', tenantId: 't1', payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1' } as DomainEvent<unknown>);
    expect(h1).not.toHaveBeenCalled();
    expect(h2).not.toHaveBeenCalled();
  });

  it('healthy returns true', async () => {
    expect(await bus.healthy()).toBe(true);
  });

  it('reset clears published events and handlers', async () => {
    await bus.subscribe('pipeline.gate.passed', jest.fn());
    await bus.publish({ eventId: 'e7', eventType: 'pipeline.gate.passed', aggregateId: 'g1', aggregateType: 'Gate', tenantId: 't1', payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1' } as DomainEvent<unknown>);
    expect(bus.published).toHaveLength(1);
    bus.reset();
    expect(bus.published).toHaveLength(0);
    expect(bus.getHandlers('pipeline.gate.passed')).toHaveLength(0);
  });

  it('publisher is accessible for test assertions', async () => {
    const event = { eventId: 'e8', eventType: 'pipeline.run.created', aggregateId: 'r1', aggregateType: 'Run', tenantId: 't1', payload: {}, timestamp: new Date().toISOString(), traceId: 'tr1', spanId: 's1' } as DomainEvent<unknown>;
    await bus.publish(event);
    expect(bus.published).toContain(event);
  });
});
