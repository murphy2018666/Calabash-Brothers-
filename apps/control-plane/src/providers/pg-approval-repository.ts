import { Injectable, Logger } from '@nestjs/common';
import type { ApprovalTicketState, ApprovalTicketInit, ApprovalVote } from '@aegisci/domain/policy/approval';

/** 统一 ISO 时间戳格式（兼容 pg-mem 行为差异） */
function normalizeTimestamp(iso: string): string {
  return iso;
}

/**
 * PgApprovalRepository —— ApprovalTicket 的 PostgreSQL 持久化实现（F4）。
 *
 * 表结构（由 ensureSchema() 在启动时创建；生产环境改用迁移工具）：
 *   CREATE TABLE approval_tickets (
 *     ticket_id       TEXT PRIMARY KEY,
 *     evidence_id     TEXT NOT NULL,
 *     tenant_id       TEXT NOT NULL,
 *     required_quorum INTEGER NOT NULL,
 *     state           TEXT NOT NULL,
 *     votes           JSONB NOT NULL DEFAULT '[]',
 *     created_at      TIMESTAMPTZ NOT NULL
 *   );
 *
 * 注入约定：
 * - 生产：从 AEGISCI_PG_URL 构造 pg.Pool，直接注入
 * - 测试：通过构造函数传入 pg-mem 实例的 .query() 方法
 */
@Injectable()
export class PgApprovalRepository {
  private readonly logger = new Logger(PgApprovalRepository.name);

  constructor(
    private readonly query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS approval_tickets (
        ticket_id       TEXT PRIMARY KEY,
        evidence_id     TEXT NOT NULL,
        tenant_id       TEXT NOT NULL,
        required_quorum INTEGER NOT NULL,
        state           TEXT NOT NULL,
        votes           JSONB NOT NULL DEFAULT '[]',
        created_at      TIMESTAMPTZ NOT NULL
      );
    `);
    this.logger.log('approval_tickets table ensured');
  }

  async save(snapshot: ApprovalTicketSnapshot): Promise<void> {
    await this.query(
      `INSERT INTO approval_tickets (ticket_id, evidence_id, tenant_id, required_quorum, state, votes, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (ticket_id) DO UPDATE SET
         state = EXCLUDED.state,
         votes = EXCLUDED.votes`,
      [
        snapshot.ticketId,
        snapshot.evidenceId,
        snapshot.tenantId,
        snapshot.requiredQuorum,
        snapshot.state,
        JSON.stringify(snapshot.votes),
        snapshot.createdAt,
      ],
    );
    this.logger.debug(
      `saved ApprovalTicket ${snapshot.ticketId} (state=${snapshot.state})`,
    );
  }

  async load(ticketId: string): Promise<ApprovalTicketSnapshot | null> {
    const rows = (await this.query(
      'SELECT * FROM approval_tickets WHERE ticket_id = $1',
      [ticketId],
    )) as unknown as { rows: Record<string, unknown>[] };

    if (!rows.rows[0]) return null;
    const r = rows.rows[0];
    return {
      ticketId: r['ticket_id'] as string,
      evidenceId: r['evidence_id'] as string,
      tenantId: r['tenant_id'] as string,
      requiredQuorum: r['required_quorum'] as number,
      state: r['state'] as ApprovalTicketState,
      votes: Array.isArray(r['votes']) ? r['votes'] : (typeof r['votes'] === 'string' ? JSON.parse(r['votes'] as string) : []),
      createdAt: typeof r['created_at'] === 'string' ? r['created_at'] : normalizeTimestamp((r['created_at'] as Date).toISOString()),
    };
  }

  async listOpen(tenantId: string): Promise<ApprovalTicketSnapshot[]> {
    const rows = (await this.query(
      "SELECT * FROM approval_tickets WHERE state = 'open' AND tenant_id = $1 ORDER BY created_at",
      [tenantId],
    )) as unknown as { rows: Record<string, unknown>[] };
    return rows.rows.map((r) => ({
      ticketId: r['ticket_id'] as string,
      evidenceId: r['evidence_id'] as string,
      tenantId: r['tenant_id'] as string,
      requiredQuorum: r['required_quorum'] as number,
      state: r['state'] as ApprovalTicketState,
      votes: Array.isArray(r['votes']) ? r['votes'] : (typeof r['votes'] === 'string' ? JSON.parse(r['votes'] as string) : []),
      createdAt: typeof r['created_at'] === 'string' ? r['created_at'] : normalizeTimestamp((r['created_at'] as Date).toISOString()),
    }));
  }

  async clear(): Promise<void> {
    await this.query('TRUNCATE approval_tickets');
  }
}

export interface ApprovalTicketSnapshot {
  ticketId: string;
  evidenceId: string;
  tenantId: string;
  requiredQuorum: number;
  state: ApprovalTicketState;
  votes: ApprovalVote[];
  createdAt: string;
}
