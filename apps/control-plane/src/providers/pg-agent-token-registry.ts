import { Injectable, Logger } from '@nestjs/common';
import type { AgentTokenRegistry, AgentTokenRegistryEntry } from '@aegisci/domain/identity';

/**
 * PgAgentTokenRegistry —— Agent Token（JTI）持久化实现，符合 AgentTokenRegistry 端口契约。
 *
 * 表结构（由 ensureSchema() 在启动时创建；生产环境改用迁移工具）：
 *   CREATE TABLE revoked_jtis (
 *     jti          TEXT PRIMARY KEY,
 *     agent_id     TEXT NOT NULL,
 *     capabilities TEXT NOT NULL DEFAULT '[]',
 *     issued_at    TIMESTAMPTZ NOT NULL,
 *     revoked_at   TIMESTAMPTZ,
 *     reason       TEXT NOT NULL DEFAULT 'manual'
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_revoked_jtis_agent_id ON revoked_jtis(agent_id);
 *
 * 职责：
 * - register()：签发后注册 JTI（内存索引 + 异步写入 DB，保持轻量）
 * - revoke()：单凭证吊销，写入 revoked_jtis 表
 * - revokeAll()：按 agentId 批量吊销，从 DB 反查并批量写入
 * - listByAgent()：按 agentId 反查所有有效（未吊销）JTIs
 * - isRevoked()：O(1) 内存索引查询 + DB 兜底
 * - loadRevoked()：启动时从 DB 恢复吊销状态
 *
 * 注入约定：
 * - 生产：从 AEGISCI_PG_URL 构造 pg.Pool，直接注入
 * - 测试：通过构造函数传入 pg-mem 实例的 .query() 方法
 */
@Injectable()
export class PgAgentTokenRegistry implements AgentTokenRegistry {
  private readonly logger = new Logger(PgAgentTokenRegistry.name);

  constructor(
    private readonly query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS revoked_jtis (
        jti          TEXT PRIMARY KEY,
        agent_id     TEXT NOT NULL,
        capabilities TEXT NOT NULL DEFAULT '[]',
        issued_at    TIMESTAMPTZ NOT NULL,
        revoked_at   TIMESTAMPTZ,
        reason       TEXT NOT NULL DEFAULT 'manual'
      );
      CREATE INDEX IF NOT EXISTS idx_revoked_jtis_agent_id ON revoked_jtis(agent_id);
    `);
    this.logger.log('revoked_jtis table ensured');
  }

  /**
   * 注册新签发的 JTI。
   * 同步写入内存索引，异步写入 DB（不阻塞签发路径）。
   */
  async register(
    jti: string,
    entry: AgentTokenRegistryEntry,
    _ttlSeconds: number,
  ): Promise<void> {
    void _ttlSeconds;
    this.regCache.set(jti, {
      agentId: entry.agentId,
      capabilities: [...entry.capabilities],
      registeredAt: new Date(entry.issuedAt).getTime(),
      expiresAt: entry.expiresAt,
    });
    // 异步写 DB，失败不阻塞签发
    this.query(
      `INSERT INTO revoked_jtis (jti, agent_id, capabilities, issued_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (jti) DO NOTHING`,
      [jti, entry.agentId, JSON.stringify(entry.capabilities), entry.issuedAt],
    ).catch((e: unknown) =>
      this.logger.warn(`register jti=${jti}: DB write failed (non-blocking):`, e),
    );
  }

  /** 按 JTI 吊销单个凭证。 */
  async revoke(jti: string): Promise<void> {
    const cached = this.regCache.get(jti);
    if (!cached) {
      this.logger.warn(`revoke: jti=${jti} not found in registry cache`);
      return;
    }
    this.regCache.delete(jti);
    this.revokedCache.add(jti);

    await this.query(
      `INSERT INTO revoked_jtis (jti, agent_id, capabilities, issued_at, revoked_at, reason)
       VALUES ($1, $2, $3, $4, NOW(), $5)
       ON CONFLICT (jti) DO UPDATE SET revoked_at = EXCLUDED.revoked_at,
                                        reason = EXCLUDED.reason`,
      [jti, cached.agentId, JSON.stringify(cached.capabilities), cached.expiresAt, 'manual'],
    );
    this.logger.debug(`revoked jti=${jti} agentId=${cached.agentId}`);
  }

  /**
   * 按 agentId 批量吊销所有凭证（熔断场景）。
   * 先从 DB 反查该 agent 的所有 JTI，再逐一吊销并持久化。
   */
  async revokeAll(agentId: string): Promise<string[]> {
    // 查询该 agent 在 DB 中的所有有效 JTIs
    const rows = (await this.query(
      `SELECT jti FROM revoked_jtis WHERE agent_id = $1 AND revoked_at IS NULL`,
      [agentId],
    )) as unknown as { rows: Array<{ jti: string }> };

    const jtis: string[] = [];

    for (const row of rows.rows) {
      this.regCache.delete(row.jti);
      this.revokedCache.add(row.jti);
      await this.query(
        `UPDATE revoked_jtis SET revoked_at = NOW(), reason = 'bulk_revoked' WHERE jti = $1`,
        [row.jti],
      );
      jtis.push(row.jti);
    }

    // 同时处理内存缓存中未持久化的 JTI
    for (const [jti, entry] of this.regCache) {
      if (entry.agentId === agentId && !this.revokedCache.has(jti)) {
        this.regCache.delete(jti);
        this.revokedCache.add(jti);
        await this.query(
          `INSERT INTO revoked_jtis (jti, agent_id, capabilities, issued_at, revoked_at, reason)
           VALUES ($1, $2, $3, $4, NOW(), 'bulk_revoked')
           ON CONFLICT (jti) DO UPDATE SET revoked_at = EXCLUDED.revoked_at,
                                            reason = EXCLUDED.reason`,
          [jti, entry.agentId, JSON.stringify(entry.capabilities), new Date(entry.registeredAt).toISOString()],
        );
        jtis.push(jti);
      }
    }

    this.logger.log(`revokedAll agentId=${agentId}: ${jtis.length} JTIs`);
    return jtis;
  }

  /**
   * 列出指定 agentId 下所有有效（未吊销）JTIs。
   * 优先内存索引，未命中时回退 DB 查询。
   */
  async listByAgent(agentId: string): Promise<string[]> {
    // 先查内存缓存（已注册但未吊销的）
    const activeFromCache: string[] = [];
    for (const [jti, entry] of this.regCache) {
      if (entry.agentId === agentId && !this.revokedCache.has(jti)) {
        activeFromCache.push(jti);
      }
    }

    // 回退 DB：查询未吊销且 agent_id 匹配的 JTIs
    const activeRows = (await this.query(
      `SELECT jti FROM revoked_jtis WHERE agent_id = $1 AND revoked_at IS NULL`,
      [agentId],
    )) as unknown as { rows: Array<{ jti: string }> };

    const revokedRows = (await this.query(
      `SELECT jti FROM revoked_jtis WHERE agent_id = $1 AND revoked_at IS NOT NULL`,
      [agentId],
    )) as unknown as { rows: Array<{ jti: string }> };

    const revokedInDb = new Set(revokedRows.rows.map((r) => r.jti));

    // 合并：内存中活跃且在 DB 中未吊销的
    const result = activeFromCache.filter((jti) => !revokedInDb.has(jti));

    // 补充 DB 中有但内存未缓存的（重启后恢复的旧凭证）
    for (const row of activeRows.rows) {
      if (!this.regCache.has(row.jti) && !this.revokedCache.has(row.jti)) {
        result.push(row.jti);
      }
    }

    return result;
  }

  /** 检查 JTI 是否已吊销（O(1) 内存查询 + DB 兜底）。 */
  async isRevoked(jti: string): Promise<boolean> {
    if (this.revokedCache.has(jti)) return true;
    if (this.regCache.has(jti)) return false;

    // 回退 DB 查询（重启后未加载进缓存的旧吊销记录）
    const rows = (await this.query(
      `SELECT 1 FROM revoked_jtis WHERE jti = $1 AND revoked_at IS NOT NULL LIMIT 1`,
      [jti],
    )) as unknown as { rows: Array<{ '1': unknown }> };

    return rows.rows.length > 0;
  }

  /** 测试/运维便利：清空全部数据（保留表结构） */
  async clear(): Promise<void> {
    await this.query('TRUNCATE revoked_jtis');
    this.regCache.clear();
    this.revokedCache.clear();
  }

  /** 启动时加载已吊销的 JTI 到内存缓存。 */
  async loadRevoked(): Promise<void> {
    const rows = (await this.query(
      `SELECT jti, agent_id FROM revoked_jtis WHERE revoked_at IS NOT NULL`,
    )) as unknown as { rows: Array<{ jti: string; agent_id: string }> };

    for (const row of rows.rows) {
      this.revokedCache.add(row.jti);
      if (!this.regCache.has(row.jti)) {
        this.regCache.set(row.jti, {
          agentId: row.agent_id,
          capabilities: [],
          registeredAt: Date.now(),
          expiresAt: new Date().toISOString(),
        });
      }
    }
    this.logger.log(`loaded ${rows.rows.length} revoked JTIs from DB`);
  }

  /** 模拟进程重启：清空内存缓存但保留 DB（由调用方负责）。 */
  discardInMemoryState(): void {
    this.regCache.clear();
    this.revokedCache.clear();
  }

  private readonly regCache = new Map<string, {
    agentId: string;
    capabilities: string[];
    registeredAt: number;
    expiresAt: string;
  }>();
  private readonly revokedCache = new Set<string>();
}
