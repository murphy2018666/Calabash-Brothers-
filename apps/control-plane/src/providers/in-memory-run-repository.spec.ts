import type { Run } from '@aegisci/shared/types';
import { InMemoryRunRepository } from './in-memory-run-repository';

/**
 * InMemoryRunRepository 单元测试（D1-2）。
 *
 * 验证 RunRepositoryPort 契约 + 内存实现扩展方法：
 * - save / load（upsert + read-your-writes）
 * - loadByRunId / loadByTenant（反向索引）
 * - findByDedupKey / registerDedupKey（首创建者获胜）
 * - clear（重启模拟）
 */
describe('InMemoryRunRepository', () => {
  let repo: InMemoryRunRepository;

  beforeEach(() => {
    repo = new InMemoryRunRepository();
  });

  function makeRun(overrides: Partial<Run> = {}): Run {
    return {
      runId: 'run_1',
      tenantId: 'tenant-1',
      pipelineId: 'pipeline-1',
      status: 'pending',
      stage: 'trigger',
      trigger: {
        event: 'push',
        repo: 'acme/x',
        ref: 'main',
        actor: 'bot',
        commit: 'c1',
      },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      ...overrides,
    };
  }

  // ── save / load ──

  it('returns null for unknown runId', async () => {
    expect(await repo.load('nope')).toBeNull();
  });

  it('saves and loads a snapshot (read-your-writes)', async () => {
    const run = makeRun();
    await repo.save(run);
    const loaded = await repo.load('run_1');
    expect(loaded).toEqual(run);
  });

  it('upserts on repeated save (same runId overwrites)', async () => {
    await repo.save(makeRun({ status: 'pending' }));
    await repo.save(makeRun({ status: 'planning', updatedAt: 't2' }));
    const loaded = await repo.load('run_1');
    expect(loaded?.status).toBe('planning');
    expect(loaded?.updatedAt).toBe('t2');
  });

  it('returns a defensive copy (mutations on loaded do not affect store)', async () => {
    await repo.save(makeRun());
    const loaded = await repo.load('run_1');
    (loaded as Run).status = 'completed';
    const reloaded = await repo.load('run_1');
    expect(reloaded?.status).toBe('pending');
  });

  // ── loadByRunId / loadByTenant ──

  it('loadByRunId mirrors load', async () => {
    await repo.save(makeRun());
    expect(await repo.loadByRunId('run_1')).toEqual(await repo.load('run_1'));
  });

  it('loadByTenant returns only runs for the tenant', async () => {
    await repo.save(makeRun({ runId: 'r1', tenantId: 't-a' }));
    await repo.save(makeRun({ runId: 'r2', tenantId: 't-a' }));
    await repo.save(makeRun({ runId: 'r3', tenantId: 't-b' }));
    const a = await repo.loadByTenant('t-a');
    expect(a.map((r) => r.runId).sort()).toEqual(['r1', 'r2']);
    const b = await repo.loadByTenant('t-b');
    expect(b.map((r) => r.runId)).toEqual(['r3']);
    expect(await repo.loadByTenant('t-z')).toEqual([]);
  });

  // ── dedup ──

  it('registerDedupKey returns true on first register, false on duplicate', async () => {
    expect(await repo.registerDedupKey('k1', 'r1')).toBe(true);
    expect(await repo.registerDedupKey('k1', 'r2')).toBe(false);
  });

  it('findByDedupKey returns the originally registered run', async () => {
    await repo.save(makeRun({ runId: 'r1' }));
    await repo.registerDedupKey('k1', 'r1');
    const hit = await repo.findByDedupKey('k1');
    expect(hit?.runId).toBe('r1');
    expect(await repo.findByDedupKey('missing')).toBeNull();
  });

  // ── 重启模拟 ──

  it('clear wipes all state (simulates control-plane restart)', async () => {
    await repo.save(makeRun({ runId: 'r1', tenantId: 't-a' }));
    await repo.registerDedupKey('k1', 'r1');
    repo.clear();
    expect(await repo.load('r1')).toBeNull();
    expect(await repo.loadByTenant('t-a')).toEqual([]);
    expect(await repo.findByDedupKey('k1')).toBeNull();
  });
});
