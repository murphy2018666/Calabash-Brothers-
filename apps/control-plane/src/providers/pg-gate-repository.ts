import { Injectable, Logger } from '@nestjs/common';
import type { GateRecord, GateRepositoryPort } from '@aegisci/domain/pipeline';

/**
 * PgGateRepository —— GateAggregate 仓储端口的 PostgreSQL 持久化实现（R3）。
 *
 * 职责：
 * - save()：将 GateRecord 快照写入 gate_records 表（upsert）
 * - load(gateId)：从 DB 读取后返回 GateRecord
 *
 * 表结构（由 ensureSchema() 在启动时创建；生产环境改用迁移工具）：
 *   CREATE TABLE gate_records (
 *     gate_id       TEXT PRIMARY KEY,
 *     run_id        TEXT NOT NULL,
 *     tenant_id     TEXT NOT NULL,
 *     stage         TEXT NOT NULL,
 *     risk_level    TEXT NOT NULL,
 *     risk_score    DOUBLE PRECISION NOT NULL,
 *     state         TEXT NOT NULL,
 *     decision      TEXT,
 *     approval_ticket_id TEXT,
 *     opened_by     TEXT,
 *     created_at    TIMESTAMPTZ NOT NULL,
 *     decided_at    TIMESTAMPTZ
 *   );
 *   CREATE INDEX idx_gate_records_run_id ON gate_records(run_id);
 *
 * 注入约定：
 * - 生产：从 AEGISCI_PG_URL 构造 pg.Pool，直接注入
 * - 测试：通过构造函数传入 pg-mem 实例的 .query() 方法
 */
@Injectable()
export class PgGateRepository implements GateRepositoryPort {
  private readonly logger = new Logger(PgGateRepository.name);

  constructor(
    private readonly query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS gate_records (
        gate_id           TEXT PRIMARY KEY,
        run_id            TEXT NOT NULL,
        tenant_id         TEXT NOT NULL,
        stage             TEXT NOT NULL,
        risk_level        TEXT NOT NULL,
        risk_score        DOUBLE PRECISION NOT NULL,
        state             TEXT NOT NULL,
        decision          TEXT,
        approval_ticket_id TEXT,
        opened_by         TEXT,
        created_at        TIMESTAMPTZ NOT NULL,
        decided_at        TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_gate_records_run_id ON gate_records(run_id);
    `);
    this.logger.log('gate_records table ensured');
  }

  async save(snapshot: GateRecord): Promise<void> {
    await this.query(
      `INSERT INTO gate_records (
         gate_id, run_id, tenant_id, stage, risk_level, risk_score,
         state, decision, approval_ticket_id, opened_by, created_at, decided_at
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (gate_id) DO UPDATE SET
         run_id        = EXCLUDED.run_id,
         tenant_id     = EXCLUDED.tenant_id,
         stage         = EXCLUDED.stage,
         risk_level    = EXCLUDED.risk_level,
         risk_score    = EXCLUDED.risk_score,
         state         = EXCLUDED.state,
         decision      = EXCLUDED.decision,
         approval_ticket_id = EXCLUDED.approval_ticket_id,
         opened_by     = EXCLUDED.opened_by,
         decided_at    = EXCLUDED.decided_at`,
      [
        snapshot.gateId,
        snapshot.runId,
        snapshot.tenantId,
        snapshot.stage,
        snapshot.riskLevel,
        snapshot.riskScore,
        snapshot.state,
        snapshot.decision ?? null,
        snapshot.approvalTicketId ?? null,
        snapshot.openedBy ?? null,
        snapshot.createdAt,
        snapshot.decidedAt ?? null,
      ],
    );
    this.logger.debug(
      `saved GateRecord ${snapshot.gateId} (run=${snapshot.runId}, state=${snapshot.state})`,
    );
  }

  async load(gateId: string): Promise<GateRecord | null> {
    const rows = (await this.query(
      'SELECT * FROM gate_records WHERE gate_id = $1',
      [gateId],
    )) as unknown as { rows: Record<string, unknown>[] };

    if (!rows.rows[0]) return null;
    const r = rows.rows[0];
    return {
      gateId: r['gate_id'] as string,
      runId: r['run_id'] as string,
      tenantId: r['tenant_id'] as string,
      stage: r['stage'] as string,
      riskLevel: r['risk_level'] as string,
      riskScore: r['risk_score'] as number,
      state: r['state'] as string,
      decision: r['decision'] ?? undefined,
      approvalTicketId: r['approval_ticket_id'] ?? undefined,
      openedBy: r['opened_by'] ?? undefined,
      createdAt: typeof r['created_at'] === 'string' ? r['created_at'] : (r['created_at'] as Date).toISOString(),
      decidedAt: r['decided_at'] ? (typeof r['decided_at'] === 'string' ? r['decided_at'] : (r['decided_at'] as Date).toISOString()) : undefined,
    } as GateRecord;
  }

  /** 测试/运维便利：清空全部数据（保留表结构） */
  async clear(): Promise<void> {
    await this.query('TRUNCATE gate_records');
  }
}
