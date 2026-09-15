import { PgApprovalRepository } from './pg-approval-repository';

/**
 * PgApprovalRepository 单元测试（R3 Approval PG 持久化，S5 补充）。
 *
 * 使用 pg-mem 提供内存中的 PostgreSQL，
 * 验证端口契约：save/load/listOpen/clear + ON CONFLICT upsert。
 */
describe('PgApprovalRepository (R3 Approval PG 持久化)', () => {
  let repo: PgApprovalRepository;
  let pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

  beforeEach(async () => {
    const { newDb } = await import('pg-mem');
    const mem = newDb();
    const pg = mem.adapters.createPg();
    pool = new pg.Pool();
    repo = new PgApprovalRepository((text: string, params?: unknown[]) => pool.query(text, params));
    await repo.ensureSchema();
  });

  afterEach(async () => {
    await pool.query('SELECT 1');
  });

  const makeSnapshot = (overrides: Partial<Record<keyof import('./pg-approval-repository').ApprovalTicketSnapshot, unknown>> & { ticketId: string }) => ({
    ticketId: 't-001',
    evidenceId: 'ev-1',
    tenantId: 't1',
    requiredQuorum: 2,
    state: 'open' as const,
    votes: [] as Array<{ voter: string; approved: boolean; castAt: string }>,
    createdAt: new Date().toISOString(),
    ...overrides,
  } as import('./pg-approval-repository').ApprovalTicketSnapshot);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R3-A: save / load
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R3-A-1: read-your-writes — save() then load() hits', async () => {
    const snap = makeSnapshot({ ticketId: 't-ryw', evidenceId: 'ev-ryw', requiredQuorum: 3 });
    await repo.save(snap);
    const loaded = await repo.load('t-ryw');

    expect(loaded).not.toBeNull();
    expect(loaded?.ticketId).toBe('t-ryw');
    expect(loaded?.evidenceId).toBe('ev-ryw');
    expect(loaded?.requiredQuorum).toBe(3);
    expect(loaded?.state).toBe('open');
  });

  it('R3-A-2: returns null for unknown ticketId', async () => {
    expect(await repo.load('nonexistent')).toBeNull();
  });

  it('R3-A-3: load preserves votes JSON', async () => {
    const snap = makeSnapshot({
      ticketId: 't-votes',
      votes: [
        { voter: 'alice', approved: true, castAt: '2025-01-01T00:00:00Z' },
        { voter: 'bob', approved: false, castAt: '2025-01-01T00:01:00Z' },
      ],
    });
    await repo.save(snap);
    const loaded = await repo.load('t-votes');

    expect(loaded).not.toBeNull();
    expect(loaded?.votes).toHaveLength(2);
    expect(loaded?.votes[0].voter).toBe('alice');
    expect(loaded?.votes[1].voter).toBe('bob');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R3-B: upsert 覆盖
  // �━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R3-B-1: upsert overwrites state on repeated save', async () => {
    await repo.save(makeSnapshot({ ticketId: 't-upsert', state: 'open' }));
    await repo.save(makeSnapshot({ ticketId: 't-upsert', state: 'approved', votes: [{ voter: 'alice', approved: true, castAt: new Date().toISOString() }] }));

    const loaded = await repo.load('t-upsert');
    expect(loaded?.state).toBe('approved');
    expect(loaded?.votes).toHaveLength(1);
  });

  it('R3-B-2: upsert preserves original createdAt', async () => {
    const originalCreatedAt = '2024-06-15T10:00:00.000Z';
    await repo.save(makeSnapshot({ ticketId: 't-created', createdAt: originalCreatedAt, state: 'open' }));
    await repo.save(makeSnapshot({ ticketId: 't-created', state: 'expired' }));

    const loaded = await repo.load('t-created');
    expect(loaded?.createdAt).toBe(originalCreatedAt);
  });

  it('R3-B-3: upsert preserves evidenceId and tenantId', async () => {
    await repo.save(makeSnapshot({ ticketId: 't-field', evidenceId: 'ev-X', tenantId: 'tenant-Y', state: 'open' }));
    await repo.save(makeSnapshot({ ticketId: 't-field', state: 'approved' }));

    const loaded = await repo.load('t-field');
    expect(loaded?.evidenceId).toBe('ev-X');
    expect(loaded?.tenantId).toBe('tenant-Y');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R3-C: listOpen
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R3-C-1: listOpen returns only open tickets', async () => {
    await repo.save(makeSnapshot({ ticketId: 't-open-1', state: 'open' }));
    await repo.save(makeSnapshot({ ticketId: 't-open-2', state: 'open' }));
    await repo.save(makeSnapshot({ ticketId: 't-closed', state: 'approved' }));

    const open = await repo.listOpen('t1');
    expect(open).toHaveLength(2);
    expect(open.map(t => t.ticketId)).toEqual(expect.arrayContaining(['t-open-1', 't-open-2']));
  });

  it('R3-C-2: listOpen returns empty when no open tickets', async () => {
    await repo.save(makeSnapshot({ ticketId: 't-closed-1', state: 'approved' }));
    await repo.save(makeSnapshot({ ticketId: 't-closed-2', state: 'expired' }));

    const open = await repo.listOpen('t1');
    expect(open).toHaveLength(0);
  });

  it('R3-C-3: listOpen ordered by created_at ascending', async () => {
    const older = makeSnapshot({ ticketId: 't-older', state: 'open', createdAt: '2024-01-01T00:00:00Z' });
    const newer = makeSnapshot({ ticketId: 't-newer', state: 'open', createdAt: '2025-01-01T00:00:00Z' });
    await repo.save(newer);
    await repo.save(older);

    const open = await repo.listOpen('t1');
    expect(open[0].ticketId).toBe('t-older');
    expect(open[1].ticketId).toBe('t-newer');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // TC-PERM-AGR-01: 跨租户隔离（等保三级 8.3.2，S13 补强）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('TC-PERM-AGR-01: listOpen filters by tenant_id — 跨租户不可见', async () => {
    // 保存两条不同租户的 open 工单
    await repo.save(makeSnapshot({ ticketId: 't-tenant-a', tenantId: 'tenant-A', state: 'open' }));
    await repo.save(makeSnapshot({ ticketId: 't-tenant-b', tenantId: 'tenant-B', state: 'open' }));

    // tenant-A 只能看到自己的工单
    const tenantA = await repo.listOpen('tenant-A');
    expect(tenantA).toHaveLength(1);
    expect(tenantA[0].ticketId).toBe('t-tenant-a');

    // tenant-B 只能看到自己的工单
    const tenantB = await repo.listOpen('tenant-B');
    expect(tenantB).toHaveLength(1);
    expect(tenantB[0].ticketId).toBe('t-tenant-b');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R3-D: clear
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R3-D-1: clear empties all tickets but preserves table', async () => {
    await repo.save(makeSnapshot({ ticketId: 't-clear-1', state: 'open' }));
    await repo.save(makeSnapshot({ ticketId: 't-clear-2', state: 'approved' }));
    await repo.clear();

    expect(await repo.load('t-clear-1')).toBeNull();
    expect(await repo.load('t-clear-2')).toBeNull();
    expect((await repo.listOpen('t1')).length).toBe(0);

    // table still exists
    const count = (await pool.query('SELECT COUNT(*) FROM approval_tickets')) as { rows: Array<{ count: string | number }> };
    expect(Number(count.rows[0].count)).toBe(0);
  });

  it('R3-D-2: clear is idempotent', async () => {
    await repo.clear();
    await repo.clear();
    expect((await repo.listOpen('t1')).length).toBe(0);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // R3-E: 类型完整性与边界
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('R3-E-1: all fields round-trip correctly', async () => {
    const snap = makeSnapshot({
      ticketId: 't-full',
      evidenceId: 'ev-full',
      tenantId: 'tenant-full',
      requiredQuorum: 3,
      state: 'open',
      votes: [
        { voter: 'user-a', approved: true, castAt: '2025-03-01T12:00:00Z' },
        { voter: 'user-b', approved: false, castAt: '2025-03-01T12:05:00Z' },
      ],
      createdAt: '2025-01-01T00:00:00Z',
    });
    await repo.save(snap);
    const loaded = await repo.load('t-full');

    expect(loaded).toMatchObject({
      ticketId: 't-full',
      evidenceId: 'ev-full',
      tenantId: 'tenant-full',
      requiredQuorum: 3,
      state: 'open',
      createdAt: expect.stringMatching(/^2025-01-01T00:00:00/),
    });
    expect(loaded?.votes).toHaveLength(2);
  });

  it('R3-E-2: different states persist correctly', async () => {
    for (const state of ['open' as const, 'approved' as const, 'expired' as const]) {
      await repo.save(makeSnapshot({ ticketId: `t-st-${state}`, state }));
      const loaded = await repo.load(`t-st-${state}`);
      expect(loaded?.state).toBe(state);
    }
  });

  it('R3-E-3: large requiredQuorum value persists', async () => {
    await repo.save(makeSnapshot({ ticketId: 't-quorum', requiredQuorum: 999, state: 'open' }));
    const loaded = await repo.load('t-quorum');
    expect(loaded?.requiredQuorum).toBe(999);
  });

  it('R3-E-4: empty votes array persists', async () => {
    await repo.save(makeSnapshot({ ticketId: 't-empty-votes', votes: [], state: 'open' }));
    const loaded = await repo.load('t-empty-votes');
    expect(loaded?.votes).toEqual([]);
  });
});
