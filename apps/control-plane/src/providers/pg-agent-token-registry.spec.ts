import { PgAgentTokenRegistry } from './pg-agent-token-registry';
import type { AgentTokenRegistryEntry } from '@aegisci/domain/identity';

/**
 * PgAgentTokenRegistry 单元测试（T-14-02 凭证吊销状态持久化完整实现）。
 *
 * 使用 pg-mem 提供内存中的 PostgreSQL（无需外部 PG 服务），
 * 验证端口契约：register / revoke / revokeAll / listByAgent / isRevoked / loadRevoked / clear。
 */
describe('PgAgentTokenRegistry (T-14-02 凭证吊销持久化完整实现)', () => {
  let registry: PgAgentTokenRegistry;
  let pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

  const makeEntry = (agentId: string): AgentTokenRegistryEntry => ({
    agentId,
    capabilities: ['git.read', 'pipeline.run'],
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    issuedAt: new Date().toISOString(),
  });

  beforeEach(async () => {
    const { newDb } = await import('pg-mem');
    const mem = newDb();
    const pg = mem.adapters.createPg();
    pool = new pg.Pool();
    registry = new PgAgentTokenRegistry((text: string, params?: unknown[]) => pool.query(text, params));
    await registry.ensureSchema();
    await registry.clear();
  });

  afterEach(async () => {
    await pool.query('SELECT 1'); // no-op to keep alive
  });

  describe('register / revoke / isRevoked', () => {
    it('TC-JTI-REG-01: register + isRevoked(false) after insertion', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-001', entry, 300);
      expect(await registry.isRevoked('jti-001')).toBe(false);
    });

    it('TC-JTI-REG-02: revoke marks jti as revoked and persists to DB', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-002', entry, 300);
      await registry.revoke('jti-002');

      expect(await registry.isRevoked('jti-002')).toBe(true);

      // 验证 DB 中有记录
      const rows = (await pool.query(
        'SELECT jti, agent_id, reason FROM revoked_jtis WHERE jti = $1',
        ['jti-002'],
      )) as unknown as { rows: Array<{ jti: string; agent_id: string; reason: string }> };
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0].jti).toBe('jti-002');
      expect(rows.rows[0].agent_id).toBe('agent-a');
      expect(rows.rows[0].reason).toBe('manual');
    });

    it('TC-JTI-REG-03: double revoke is idempotent (single row in DB)', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-003', entry, 300);
      await registry.revoke('jti-003');
      await registry.revoke('jti-003');

      const rows = (await pool.query(
        'SELECT * FROM revoked_jtis WHERE jti = $1',
        ['jti-003'],
      )) as unknown as { rows: unknown[] };
      expect(rows.rows).toHaveLength(1);
      expect(await registry.isRevoked('jti-003')).toBe(true);
    });

    it('TC-JTI-REG-04: revoke unknown jti does not throw', async () => {
      await expect(registry.revoke('jti-unknown')).resolves.toBeUndefined();
      expect(await registry.isRevoked('jti-unknown')).toBe(false);
    });
  });

  describe('listByAgent', () => {
    it('TC-JTI-LIST-01: listByAgent returns active JTIs for agent', async () => {
      const entryA = makeEntry('agent-a');
      const entryB = makeEntry('agent-b');
      await registry.register('jti-a1', entryA, 300);
      await registry.register('jti-a2', entryA, 300);
      await registry.register('jti-b1', entryB, 300);

      const active = await registry.listByAgent('agent-a');
      expect(active).toContain('jti-a1');
      expect(active).toContain('jti-a2');
      expect(active).not.toContain('jti-b1');
    });

    it('TC-JTI-LIST-02: listByAgent excludes revoked JTIs', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-a1', entry, 300);
      await registry.register('jti-a2', entry, 300);
      await registry.revoke('jti-a1');

      const active = await registry.listByAgent('agent-a');
      expect(active).not.toContain('jti-a1');
      expect(active).toContain('jti-a2');
    });
  });

  describe('revokeAll', () => {
    it('TC-JTI-RA-01: revokeAll revokes all JTIs for an agent and persists', async () => {
      const entryA = makeEntry('agent-a');
      const entryB = makeEntry('agent-b');
      await registry.register('jti-a1', entryA, 300);
      await registry.register('jti-a2', entryA, 300);
      await registry.register('jti-b1', entryB, 300);

      const revoked = await registry.revokeAll('agent-a');
      expect(revoked.sort()).toEqual(['jti-a1', 'jti-a2'].sort());
      expect(await registry.isRevoked('jti-a1')).toBe(true);
      expect(await registry.isRevoked('jti-a2')).toBe(true);
      expect(await registry.isRevoked('jti-b1')).toBe(false);
    });

    it('TC-JTI-RA-02: revokeAll for unknown agent returns empty array', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-a1', entry, 300);

      const revoked = await registry.revokeAll('agent-unknown');
      expect(revoked).toEqual([]);
      expect(await registry.isRevoked('jti-a1')).toBe(false);
    });

    it('TC-JTI-RA-03: revokeAll persists to DB for startup recovery', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-ra-03', entry, 300);
      await registry.revokeAll('agent-a');

      // 清空内存，模拟重启
      registry.discardInMemoryState();
      // 重启后未 loadRevoked，isRevoked 回退到 DB 查询
      expect(await registry.isRevoked('jti-ra-03')).toBe(true);

      // loadRevoked 后恢复正常
      await registry.loadRevoked();
      expect(await registry.isRevoked('jti-ra-03')).toBe(true);
    });
  });

  describe('loadRevoked (startup recovery)', () => {
    it('TC-JTI-REC-01: loadRevoked restores revoked state across process restart', async () => {
      const entry = makeEntry('agent-a');
      await registry.register('jti-rec-01', entry, 300);
      await registry.revoke('jti-rec-01');

      // 验证吊销已持久化到 DB
      const rows = (await pool.query(
        'SELECT jti FROM revoked_jtis WHERE jti = $1 AND revoked_at IS NOT NULL',
        ['jti-rec-01'],
      )) as unknown as { rows: Array<{ jti: string }> };
      expect(rows.rows).toHaveLength(1);

      // 模拟重启：只清空内存缓存，DB 保留
      registry.discardInMemoryState();
      // isRevoked 会回退到 DB 查询，仍应返回 true
      expect(await registry.isRevoked('jti-rec-01')).toBe(true);

      // 完全清除（TRUNCATE + 清空缓存），验证状态可被重置
      await registry.clear();
      expect(await registry.isRevoked('jti-rec-01')).toBe(false);

      // 从 DB 恢复（刚 clear 后 DB 为空，loadRevoked 无数据）
      await registry.loadRevoked();
      expect(await registry.isRevoked('jti-rec-01')).toBe(false);

      // 重新注册并吊销，再次验证完整流程
      await registry.register('jti-rec-01', entry, 300);
      await registry.revoke('jti-rec-01');
      expect(await registry.isRevoked('jti-rec-01')).toBe(true);

      // 清空内存模拟重启，loadRevoked 从 DB 恢复
      registry.discardInMemoryState();
      expect(await registry.isRevoked('jti-rec-01')).toBe(true); // DB fallback
      await registry.loadRevoked();
      expect(await registry.isRevoked('jti-rec-01')).toBe(true); // 内存恢复
    });
  });

  describe('isRevoked fallback (no cache)', () => {
    it('TC-JTI-FALLBACK-01: isRevoked queries DB when not in cache', async () => {
      // 不通过 register 直接写入 DB（模拟重启后恢复的吊销记录）
      await pool.query(
        `INSERT INTO revoked_jtis (jti, agent_id, capabilities, issued_at, revoked_at, reason) VALUES ($1, $2, $3, $4, NOW(), $5)`,
        ['jti-fb-01', 'agent-a', '[]', new Date().toISOString(), 'manual'],
      );

      expect(await registry.isRevoked('jti-fb-01')).toBe(true);
    });
  });

  describe('cross-agent isolation', () => {
    it('TC-JTI-ISOLATION-01: revokeAll does not affect other agents JTIs', async () => {
      const entryA = makeEntry('agent-a');
      const entryB = makeEntry('agent-b');
      await registry.register('jti-a1', entryA, 300);
      await registry.register('jti-b1', entryB, 300);
      await registry.revokeAll('agent-a');

      expect(await registry.isRevoked('jti-a1')).toBe(true);
      expect(await registry.isRevoked('jti-b1')).toBe(false);

      const bActive = await registry.listByAgent('agent-b');
      expect(bActive).toContain('jti-b1');
    });
  });
});
