/**
 * InMemoryConnectionGateway 单元测试（D2-5）。
 */
import { InMemoryConnectionGateway } from './in-memory-connection-gateway';

describe('InMemoryConnectionGateway (D2-5)', () => {
  let gw: InMemoryConnectionGateway;

  beforeEach(() => {
    gw = new InMemoryConnectionGateway();
  });

  it('dispatchJob records the dispatch', async () => {
    await gw.dispatchJob({ runId: 'r1', jobId: 'j1', attempt: 1, pool: 'default', spec: { cmd: 'test' } });
    expect(gw.dispatched).toHaveLength(1);
    expect(gw.dispatched[0]).toEqual({ runId: 'r1', jobId: 'j1', attempt: 1, pool: 'default', spec: { cmd: 'test' } });
  });

  it('cancelJob records the cancellation', async () => {
    await gw.cancelJob({ runId: 'r1', jobId: 'j1', reason: 'timeout' });
    expect(gw.cancelled).toHaveLength(1);
    expect(gw.cancelled[0]).toEqual({ runId: 'r1', jobId: 'j1', reason: 'timeout' });
  });

  it('healthy returns true', async () => {
    expect(await gw.healthy()).toBe(true);
  });

  it('reset clears all records', async () => {
    await gw.dispatchJob({ runId: 'r1', jobId: 'j1', attempt: 1, pool: 'default', spec: {} });
    await gw.cancelJob({ runId: 'r1', jobId: 'j1', reason: 'kill' });
    expect(gw.dispatched).toHaveLength(1);
    expect(gw.cancelled).toHaveLength(1);
    gw.reset();
    expect(gw.dispatched).toHaveLength(0);
    expect(gw.cancelled).toHaveLength(0);
  });
});
