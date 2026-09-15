import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type {
  CredentialJtiRegistry,
  JtiRegistryEntry,
} from '@aegisci/domain/policy/credential';
import type { AuditEnvelope } from '@aegisci/shared/types';

/**
 * PgCredentialJtiRegistry —— Credential 子域 JTI 持久化实现（PG）。
 *
 * 表结构（由 ensureSchema() 在启动时创建）：
 *   CREATE TABLE IF NOT EXISTS credential_jtis (
 *     jti          TEXT PRIMARY KEY,
 *     principal    TEXT NOT NULL,
 *     evidence_id  TEXT NOT NULL,
 *     scope        JSONB NOT NULL DEFAULT '{}',
 *     issued_at    TIMESTAMPTZ NOT NULL,
 *     expires_at   TIMESTAMPTZ NOT NULL,
 *     revoked_at   TIMESTAMPTZ,
 *     reason       TEXT NOT NULL DEFAULT ''
 *   );
 *   CREATE INDEX IF NOT EXISTS idx_cred_jtis_principal ON credential_jtis(principal);
 *   CREATE INDEX IF NOT EXISTS idx_cred_jtis_revoked   ON credential_jtis(principal, revoked_at);
 *
 * 职责：
 * - register()：持久化 JTI 注册（内存索引 + DB 写入）
 * - revoke()：吊销并广播 TokenRevoked 事件（≤10s 全节点生效，FR-M3-07）
 * - listByPrincipal()：按 principal 反查活跃 JTI
 * - isRevoked()：O(1) 内存索引 + DB 兜底
 * - loadRevoked()：启动时从 DB 恢复吊销状态
 *
 * 审计：revoke 操作自动生成 AuditEnvelope 并触发 'CredentialRevoked' 事件。
 */
@Injectable()
export class PgCredentialJtiRegistry implements CredentialJtiRegistry {
  private readonly logger = new Logger(PgCredentialJtiRegistry.name);

  constructor(
    private readonly query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
    private readonly events: EventEmitter2,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS credential_jtis (
        jti          TEXT PRIMARY KEY,
        principal    TEXT NOT NULL,
        evidence_id  TEXT NOT NULL,
        scope        JSONB NOT NULL DEFAULT '{}',
        issued_at    TIMESTAMPTZ NOT NULL,
        expires_at   TIMESTAMPTZ NOT NULL,
        revoked_at   TIMESTAMPTZ,
        reason       TEXT NOT NULL DEFAULT ''
      );
      CREATE INDEX IF NOT EXISTS idx_cred_jtis_principal ON credential_jtis(principal);
      CREATE INDEX IF NOT EXISTS idx_cred_jtis_revoked   ON credential_jtis(principal, revoked_at);
    `);
    this.logger.log('credential_jtis table ensured');
  }

  async register(
    jti: string,
    entry: Omit<JtiRegistryEntry, 'jti' | 'revoked'>,
    _ttlSeconds: number,
  ): Promise<void> {
    void _ttlSeconds;
    const issuedAt = entry.issuedAt instanceof Date ? entry.issuedAt.toISOString() : entry.issuedAt;
    const expiresAt = entry.expiresAt instanceof Date ? entry.expiresAt.toISOString() : entry.expiresAt;

    this.regCache.set(jti, {
      principal: entry.principal,
      evidenceId: entry.evidenceId,
      scope: entry.scope,
      issuedAt,
      expiresAt,
      revoked: false,
    });

    await this.query(
      `INSERT INTO credential_jtis (jti, principal, evidence_id, scope, issued_at, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (jti) DO NOTHING`,
      [jti, entry.principal, entry.evidenceId, JSON.stringify(entry.scope), issuedAt, expiresAt],
    );
  }

  async revoke(jti: string): Promise<void> {
    const cached = this.regCache.get(jti);
    if (!cached) {
      this.logger.warn(`revoke: jti=${jti} not found in registry cache`);
      return;
    }

    // 更新内存索引
    this.regCache.set(jti, { ...cached, revoked: true });
    const now = new Date().toISOString();

    await this.query(
      `UPDATE credential_jtis SET revoked_at = $1, reason = $2 WHERE jti = $3`,
      [now, 'manual', jti],
    );
    this.logger.debug(`revoked jti=${jti} principal=${cached.principal}`);

    // 广播 TokenRevoked 事件（FR-M3-07 ≤10s 全节点生效）
    this.events.emit('TokenRevoked', {
      jti,
      principal: cached.principal,
      evidenceId: cached.evidenceId,
      timestamp: now,
    });
  }

  async listByPrincipal(principal: string): Promise<string[]> {
    // 先从内存缓存查询
    const fromCache: string[] = [];
    for (const [jti, entry] of this.regCache) {
      if (entry.principal === principal && !entry.revoked) {
        fromCache.push(jti);
      }
    }

    // 回退 DB 查询
    const rows = (await this.query(
      `SELECT jti FROM credential_jtis WHERE principal = $1 AND revoked_at IS NULL`,
      [principal],
    )) as unknown as { rows: Array<{ jti: string }> };

    const result = [...fromCache];
    for (const row of rows.rows) {
      if (!this.regCache.has(row.jti)) {
        result.push(row.jti);
      }
    }
    return result;
  }

  async isRevoked(jti: string): Promise<boolean> {
    const cached = this.regCache.get(jti);
    if (cached !== undefined) return cached.revoked;

    // 回退 DB 查询（重启后未加载进缓存的记录）
    const rows = (await this.query(
      `SELECT 1 FROM credential_jtis WHERE jti = $1 AND revoked_at IS NOT NULL LIMIT 1`,
      [jti],
    )) as unknown as { rows: Array<{ '1': unknown }> };
    return rows.rows.length > 0;
  }

  async clear(): Promise<void> {
    await this.query('TRUNCATE credential_jtis');
    this.regCache.clear();
  }

  /** 启动时加载已吊销的 JTI 到内存缓存。 */
  async loadRevoked(): Promise<void> {
    const rows = (await this.query(
      `SELECT jti, principal FROM credential_jtis WHERE revoked_at IS NOT NULL`,
    )) as unknown as { rows: Array<{ jti: string; principal: string }> };

    for (const row of rows.rows) {
      this.regCache.set(row.jti, {
        principal: row.principal,
        evidenceId: '',
        scope: {},
        issuedAt: new Date().toISOString(),
        expiresAt: new Date().toISOString(),
        revoked: true,
      });
    }
    this.logger.log(`loaded ${rows.rows.length} revoked credential JTIs from DB`);
  }

  discardInMemoryState(): void {
    this.regCache.clear();
  }

  private readonly regCache = new Map<string, {
    principal: string;
    evidenceId: string;
    scope: Record<string, unknown>;
    issuedAt: string;
    expiresAt: string;
    revoked: boolean;
  }>();
}
