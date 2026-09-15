/**
 * E8-2: AuditRetrievalService —— 审计检索 API 服务（G1/G2）
 *
 * 职责：
 * - 实现 GET /v1/audit/query?runId=&principalId=&action=&result=&from=&to=&limit=&cursor=
 * - 按 runId / principalId / action / result / 时间窗口多维度检索审计信封
 * - 支持游标分页（cursor-based pagination）
 * - 保证 audit:read 权限约束（只读不可写）
 * - 输出结构化审计摘要（价值流可消费格式）
 *
 * 对应设计文档：
 * - DES-7 API: GET /v1/audit/query?runId= — 审计检索导出
 * - DES-8: WORM 审计存储，追加分区 audit/{tenant}/{yyyy-mm-dd}/
 * - FR-AUDIT-01: 审计数据不可删除、不可覆盖
 *
 * 权限：audit:read（不可写，全平台无人持有写口）
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import type { AuditEnvelope } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 查询参数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AuditQueryParams {
  /** 按 runId 过滤 */
  runId?: string;
  /** 按 principalId 过滤 */
  principalId?: string;
  /** 按 action 类型过滤（如 pipeline.gate.passed） */
  action?: string;
  /** 按 result 过滤（success | denied | failed） */
  result?: 'success' | 'denied' | 'failed';
  /** 时间范围起始（ISO 8601） */
  from?: string;
  /** 时间范围结束（ISO 8601） */
  to?: string;
  /** 每页条数（默认 50，最大 200） */
  limit?: number;
  /** 游标（上一页最后一条的 envelopeId） */
  cursor?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 查询结果
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AuditQueryResult {
  /** 审计信封列表 */
  entries: AuditEnvelope[];
  /** 总条数（精确计数，仅在 limit ≤ 50 时返回） */
  total?: number;
  /** 下一页游标（无更多时为空字符串） */
  nextCursor: string;
  /** 查询耗时（毫秒） */
  queryMs: number;
  /** 是否截断（total > limit 时 true） */
  truncated: boolean;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 审计统计摘要
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AuditSummary {
  /** 租户 ID */
  tenantId: string;
  /** 时间范围 */
  from: string;
  to: string;
  /** 总审计条目数 */
  totalEnvelopes: number;
  /** 按结果分组的计数 */
  byResult: { success: number; denied: number; failed: number };
  /** 按 action 类型分组的计数（TOP 10） */
  topActions: Array<{ action: string; count: number }>;
  /** 按 principal 分组的计数（TOP 10） */
  topPrincipals: Array<{ principalId: string; principalType: string; count: number }>;
  /** 被拒绝的操作列表 */
  deniedActions: AuditEnvelope[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 仓储接口
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AuditRepositoryPort {
  /** 按条件检索审计信封 */
  query(params: AuditQueryParams): Promise<AuditEnvelope[]>;
  /** 获取租户所有审计信封（用于统计） */
  listByTenant(tenantId: string): Promise<AuditEnvelope[]>;
  /** 检查 envelopeId 是否存在 */
  exists(envelopeId: string): Promise<boolean>;
  /** 清空（仅测试用） */
  clear(): void;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class AuditRetrievalService {
  private readonly logger = new Logger(AuditRetrievalService.name);
  private readonly maxLimit = 200;
  private readonly defaultLimit = 50;

  constructor(@Inject('AuditRepositoryPort') private readonly repo: AuditRepositoryPort) {}

  /**
   * 审计检索入口。
   * 对应 API: GET /v1/audit/query?runId=&principalId=&action=&result=&from=&to=&limit=&cursor=
   */
  async query(params: AuditQueryParams): Promise<AuditQueryResult> {
    const start = Date.now();

    // 参数校验与规范化
    const validated = this.validateParams(params);

    // 执行检索
    const entries = await this.repo.query(validated);

    // 游标分页
    let nextCursor = '';
    const originalLength = entries.length;
    if (entries.length >= validated.limit) {
      const lastEntry = entries[entries.length - 1];
      nextCursor = lastEntry.envelopeId;
      entries.pop(); // 移除游标条目（不包含在结果中）
    }

    const queryMs = Date.now() - start;
    this.logger.debug(
      `Audit query: ${entries.length} entries in ${queryMs}ms (limit=${validated.limit}, cursor=${params.cursor ?? 'none'})`,
    );

    return {
      entries,
      nextCursor,
      queryMs,
      truncated: originalLength >= validated.limit,
      total: validated.limit <= 50 ? entries.length + (nextCursor ? 1 : 0) : undefined,
    };
  }

  /**
   * 生成审计统计摘要。
   * 用于价值流视图展示和合规报表。
   */
  async generateSummary(tenantId: string, from: string, to: string): Promise<AuditSummary> {
    const start = Date.now();

    const allEntries = await this.repo.listByTenant(tenantId);
    const filtered = allEntries.filter((e) => e.timestamp >= from && e.timestamp <= to);

    // 按结果分组
    const byResult = { success: 0, denied: 0, failed: 0 };
    for (const e of filtered) {
      byResult[e.result]++;
    }

    // 按 action 分组（TOP 10）
    const actionCount = new Map<string, number>();
    for (const e of filtered) {
      actionCount.set(e.action, (actionCount.get(e.action) ?? 0) + 1);
    }
    const topActions = Array.from(actionCount.entries())
      .map(([action, count]) => ({ action, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // 按 principal 分组（TOP 10）
    const principalCount = new Map<string, { count: number; principalType: string }>();
    for (const e of filtered) {
      const existing = principalCount.get(e.principalId) ?? { count: 0, principalType: e.principalType };
      principalCount.set(e.principalId, { count: existing.count + 1, principalType: e.principalType });
    }
    const topPrincipals = Array.from(principalCount.entries())
      .map(([principalId, data]) => ({ principalId, ...data }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // 被拒绝的操作
    const deniedActions = filtered.filter((e) => e.result === 'denied');

    const queryMs = Date.now() - start;
    this.logger.debug(
      `Audit summary generated: ${filtered.length} envelopes in ${queryMs}ms`,
    );

    return {
      tenantId,
      from,
      to,
      totalEnvelopes: filtered.length,
      byResult,
      topActions,
      topPrincipals,
      deniedActions,
    };
  }

  /**
   * 验证并规范化查询参数。
   */
  private validateParams(params: AuditQueryParams): Required<Omit<AuditQueryParams, 'cursor'>> & { cursor?: string } {
    const limit = Math.min(Math.max(params.limit ?? this.defaultLimit, 1), this.maxLimit);
    return {
      runId: params.runId,
      principalId: params.principalId,
      action: params.action,
      result: params.result,
      from: params.from,
      to: params.to,
      limit,
      cursor: params.cursor,
    };
  }

  /**
   * 按 envelopeId 检索单条审计记录。
   */
  async getEnvelope(envelopeId: string): Promise<AuditEnvelope | null> {
    const entries = await this.repo.query({
      principalId: '',
      limit: 1,
      cursor: undefined,
    });
    // 简单实现：遍历所有条目查找（生产环境应优化为索引查询）
    const allEntries = await this.repo.listByTenant('*');
    return allEntries.find((e) => e.envelopeId === envelopeId) ?? null;
  }
}
