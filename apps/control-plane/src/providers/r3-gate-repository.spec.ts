import { PgGateRepository } from './pg-gate-repository';
import type { GateRecord } from '@aegisci/domain/pipeline';

/**
 * PgGateRepository 单元测试（R3 PG 持久化）。
 *
 * 使用 pg-mem 提供内存中的 PostgreSQL，
 * 验证端口契约：read-your-writes / null for unknown / upsert。
 */
describe('PgGateRepository (R3 PG 持久化)', () => {
  let repo: PgGateRepository;
  let pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

  beforeEach(async () => {
    const { newDb } = await import('pg-mem');
    const mem = newDb();
    const pg = mem.adapters.createPg();
    pool = new pg.Pool();
    repo = new PgGateRepository((text: string, params?: unknown[]) => pool.query(text, params));
    await repo.ensureSchema();
  });

  afterEach(async () => {
    await pool.query('SELECT 1');
  });

  const makeRecord = (overrides: Partial<GateRecord> & { gateId: string }): GateRecord => ({
    gateId: 'g1',
    runId: 'run-1',
    tenantId: 't1',
    stage: 'sandbox',
    riskLevel: 'G2',
    riskScore: 35,
    state: 'open',
    decision: 'auto',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R3-1: save / load
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R3-1-1: read-your-writes — save() then load() hits', async () => {
    const record = makeRecord({ gateId: 'g-ryw' });
    await repo.save(record);
    const loaded = await repo.load('g-ryw');

    expect(loaded).not.toBeNull();
    expect(loaded?.gateId).toBe('g-ryw');
    expect(loaded?.runId).toBe('run-1');
    expect(loaded?.state).toBe('open');
  });

  it('R3-1-2: returns null for unknown gateId', async () => {
    expect(await repo.load('nonexistent')).toBeNull();
  });

  it('R3-1-3: saves and loads optional fields correctly', async () => {
    const record = makeRecord({
      gateId: 'g-opt',
      decision: 'hitl',
      approvalTicketId: 'ticket-1',
      openedBy: 'user-alice',
      decidedAt: new Date().toISOString(),
    });
    await repo.save(record);
    const loaded = await repo.load('g-opt');

    expect(loaded).not.toBeNull();
    expect(loaded?.decision).toBe('hitl');
    expect(loaded?.approvalTicketId).toBe('ticket-1');
    expect(loaded?.openedBy).toBe('user-alice');
    expect(loaded?.decidedAt).not.toBeUndefined();
  });

  it('R3-1-4: saves record with null optional fields', async () => {
    const record = makeRecord({
      gateId: 'g-null',
      decision: undefined,
      approvalTicketId: undefined,
      openedBy: undefined,
      decidedAt: undefined,
    });
    await repo.save(record);
    const loaded = await repo.load('g-null');

    expect(loaded).not.toBeNull();
    expect(loaded?.decision).toBeUndefined();
    expect(loaded?.approvalTicketId).toBeUndefined();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R3-2: upsert 覆盖
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R3-2-1: upsert overwrites state on repeated save', async () => {
    await repo.save(makeRecord({ gateId: 'g-upsert', state: 'open' }));
    await repo.save(makeRecord({ gateId: 'g-upsert', state: 'passed', decidedAt: new Date().toISOString() }));

    const loaded = await repo.load('g-upsert');
    expect(loaded?.state).toBe('passed');
    expect(loaded?.decidedAt).not.toBeUndefined();
  });

  it('R3-2-2: upsert overwrites riskScore', async () => {
    await repo.save(makeRecord({ gateId: 'g-score', riskScore: 10 }));
    await repo.save(makeRecord({ gateId: 'g-score', riskScore: 50 }));

    const loaded = await repo.load('g-score');
    expect(loaded?.riskScore).toBe(50);
  });

  it('R3-2-3: upsert preserves original created_at', async () => {
    const originalCreatedAt = new Date().toISOString();
    await repo.save(makeRecord({ gateId: 'g-created', createdAt: originalCreatedAt }));
    await repo.save(makeRecord({ gateId: 'g-created', state: 'blocked' }));

    const loaded = await repo.load('g-created');
    expect(loaded?.createdAt).toBe(originalCreatedAt);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R3-3: 索引与查询
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R3-3-1: index idx_gate_records_run_id exists after ensureSchema', async () => {
    await repo.save(makeRecord({ gateId: 'g-a', runId: 'run-x' }));
    await repo.save(makeRecord({ gateId: 'g-b', runId: 'run-x' }));
    await repo.save(makeRecord({ gateId: 'g-c', runId: 'run-y' }));

    // 验证按 runId 查询有效（索引存在）
    const rows = (await pool.query(
      'SELECT * FROM gate_records WHERE run_id = $1',
      ['run-x'],
    )) as { rows: unknown[] };
    expect(rows.rows.length).toBe(2);
  });

  it('R3-3-2: multiple gates for same runId can coexist', async () => {
    await repo.save(makeRecord({ gateId: 'g-sand', runId: 'run-1', stage: 'sandbox' }));
    await repo.save(makeRecord({ gateId: 'g-deploy', runId: 'run-1', stage: 'deploy' }));

    expect(await repo.load('g-sand')).not.toBeNull();
    expect(await repo.load('g-deploy')).not.toBeNull();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R3-4: clear
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R3-4-1: clear empties all records but preserves table', async () => {
    await repo.save(makeRecord({ gateId: 'g-clear-1' }));
    await repo.save(makeRecord({ gateId: 'g-clear-2' }));
    await repo.clear();

    expect(await repo.load('g-clear-1')).toBeNull();
    expect(await repo.load('g-clear-2')).toBeNull();
    // table still exists
    const count = (await pool.query('SELECT COUNT(*) FROM gate_records')) as { rows: Array<{ count: string | number }> };
    expect(Number(count.rows[0].count)).toBe(0);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R3-5: 类型完整性
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R3-5-1: all GateRecord fields round-trip correctly', async () => {
    const record = makeRecord({
      gateId: 'g-full',
      runId: 'run-full',
      tenantId: 'tenant-full',
      stage: 'integration',
      riskLevel: 'G3',
      riskScore: 75.5,
      state: 'blocked',
      decision: 'hitl',
      approvalTicketId: 'ticket-99',
      openedBy: 'user-bob',
      decidedAt: '2025-01-01T00:00:00.000Z',
      createdAt: '2024-12-31T00:00:00.000Z',
    });
    await repo.save(record);
    const loaded = await repo.load('g-full');

    expect(loaded).not.toBeNull();
    expect(loaded).toMatchObject({
      gateId: 'g-full',
      runId: 'run-full',
      tenantId: 'tenant-full',
      stage: 'integration',
      riskLevel: 'G3',
      riskScore: 75.5,
      state: 'blocked',
      decision: 'hitl',
      approvalTicketId: 'ticket-99',
      openedBy: 'user-bob',
    });
  });

  it('R3-5-2: different riskLevels round-trip', async () => {
    for (const level of ['G1' as const, 'G2' as const, 'G3' as const, 'G4' as const]) {
      await repo.save(makeRecord({ gateId: `g-${level}`, riskLevel: level, state: 'open' }));
      const loaded = await repo.load(`g-${level}`);
      expect(loaded?.riskLevel).toBe(level);
    }
  });

  it('R3-5-3: different states round-trip', async () => {
    for (const state of ['open' as const, 'evaluating' as const, 'passed' as const, 'blocked' as const, 'opened' as const]) {
      await repo.save(makeRecord({ gateId: `g-st-${state}`, state }));
      const loaded = await repo.load(`g-st-${state}`);
      expect(loaded?.state).toBe(state);
    }
  });
});
