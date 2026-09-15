import { EventEmitter2 } from '@nestjs/event-emitter';
import { PgCredentialJtiRegistry } from './pg-credential-jti-registry';
import type { JtiRegistryEntry } from '@aegisci/domain/policy/credential';

describe('PgCredentialJtiRegistry (T-14-03 凭证吊销持久化 + 审计)', () => {
  let registry: PgCredentialJtiRegistry;
  let pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  let events: EventEmitter2;

  const makeEntry = (principal: string): Omit<JtiRegistryEntry, 'jti' | 'revoked'> => ({
    principal,
    evidenceId: 'ev-test-001',
    scope: { actions: ['deploy'], resources: [], environment: 'tenant-a', ttl: 1800 },
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    issuedAt: new Date().toISOString(),
  });

  beforeEach(async () => {
    const { newDb } = await import('pg-mem');
    const mem = newDb();
    const pg = mem.adapters.createPg();
    pool = new pg.Pool();
    events = new EventEmitter2();
    registry = new PgCredentialJtiRegistry(
      (text: string, params?: unknown[]) => pool.query(text, params),
      events,
    );
    await registry.ensureSchema();
    await registry.clear();
  });

  describe('register / isRevoked / revoke', () => {
    it('TC-CRED-JTI-REG-01: register then isRevoked returns false', async () => {
      const entry = makeEntry('agent-1');
      await registry.register('jti-c1', entry, 300);
      expect(await registry.isRevoked('jti-c1')).toBe(false);
    });

    it('TC-CRED-JTI-REG-02: revoke marks as revoked and emits TokenRevoked event', async () => {
      const entry = makeEntry('agent-1');
      await registry.register('jti-c2', entry, 300);

      const handler = jest.fn();
      events.on('TokenRevoked', handler);
      await registry.revoke('jti-c2');

      expect(await registry.isRevoked('jti-c2')).toBe(true);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({ jti: 'jti-c2', principal: 'agent-1' }),
      );
    });

    it('TC-CRED-JTI-REG-03: double revoke is idempotent', async () => {
      const entry = makeEntry('agent-1');
      await registry.register('jti-c3', entry, 300);
      await registry.revoke('jti-c3');
      await registry.revoke('jti-c3');
      expect(await registry.isRevoked('jti-c3')).toBe(true);
    });

    it('TC-CRED-JTI-REG-04: revoke unknown jti does not throw', async () => {
      await expect(registry.revoke('jti-unknown')).resolves.toBeUndefined();
      expect(await registry.isRevoked('jti-unknown')).toBe(false);
    });
  });

  describe('listByPrincipal', () => {
    it('TC-CRED-LIST-01: listByPrincipal returns active JTIs for principal', async () => {
      const entryA = makeEntry('agent-a');
      const entryB = makeEntry('agent-b');
      await registry.register('jti-la1', entryA, 300);
      await registry.register('jti-la2', entryA, 300);
      await registry.register('jti-lb1', entryB, 300);

      const active = await registry.listByPrincipal('agent-a');
      expect(active).toContain('jti-la1');
      expect(active).toContain('jti-la2');
      expect(active).not.toContain('jti-lb1');
    });

    it('TC-CRED-LIST-02: listByPrincipal excludes revoked JTIs', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-le1', entry, 300);
      await registry.register('jti-le2', entry, 300);
      await registry.revoke('jti-le1');

      const active = await registry.listByPrincipal('agent-a');
      expect(active).not.toContain('jti-le1');
      expect(active).toContain('jti-le2');
    });
  });

  describe('loadRevoked (startup recovery)', () => {
    it('TC-CRED-REC-01: loadRevoked restores revoked state after process restart', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-lr-01', entry, 300);
      await registry.revoke('jti-lr-01');

      // 验证 DB 中有记录
      const rows = (await pool.query(
        'SELECT jti FROM credential_jtis WHERE jti = $1 AND revoked_at IS NOT NULL',
        ['jti-lr-01'],
      )) as unknown as { rows: Array<{ jti: string }> };
      expect(rows.rows).toHaveLength(1);

      // 模拟重启
      registry.discardInMemoryState();
      // 未 loadRevoked 时，isRevoked 回退到 DB 查询
      expect(await registry.isRevoked('jti-lr-01')).toBe(true);

      // loadRevoked 恢复后内存索引生效
      await registry.loadRevoked();
      expect(await registry.isRevoked('jti-lr-01')).toBe(true);
    });

    it('TC-CRED-REC-02: clear resets all state including DB', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-cr-02', entry, 300);
      await registry.revoke('jti-cr-02');

      await registry.clear();
      expect(await registry.isRevoked('jti-cr-02')).toBe(false);
    });
  });

  describe('DB persistence', () => {
    it('TC-CRED-DB-01: register persists to credential_jtis table', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-db-01', entry, 300);

      const rows = (await pool.query(
        'SELECT jti, principal, evidence_id, revoked_at FROM credential_jtis WHERE jti = $1',
        ['jti-db-01'],
      )) as unknown as { rows: Array<{ jti: string; principal: string; evidence_id: string; revoked_at: unknown }> };
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].jti).toBe('jti-db-01');
      expect(rows.rows[0].principal).toBe('agent-a');
      expect(rows.rows[0].evidence_id).toBe('ev-test-001');
      expect(rows.rows[0].revoked_at).toBeNull();
    });

    it('TC-CRED-DB-02: revoke updates revoked_at in DB', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-db-02', entry, 300);
      await registry.revoke('jti-db-02');

      const rows = (await pool.query(
        'SELECT revoked_at FROM credential_jtis WHERE jti = $1',
        ['jti-db-02'],
      )) as unknown as { rows: Array<{ revoked_at: unknown }> };
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].revoked_at).not.toBeNull();
    });
  });

  describe('cross-principal isolation', () => {
    it('TC-CRED-ISOLATION-01: revoke does not affect other principals', async () => {
      const entryA = makeEntry('agent-a');
      const entryB = makeEntry('agent-b');
      await registry.register('jti-i-a1', entryA, 300);
      await registry.register('jti-i-b1', entryB, 300);
      await registry.revoke('jti-i-a1');

      expect(await registry.isRevoked('jti-i-a1')).toBe(true);
      expect(await registry.isRevoked('jti-i-b1')).toBe(false);
    });
  });
});
