/**
 * BlackboardSession 聚合根（OR 域）
 *
 * 对应设计文档：
 * - ADD §5.2 / detailed-design §4.6.2 M1 黑板模式
 * - detailed-design §4.5 上下文分层（BlackboardSession 级）
 * - DES-4.3 每个黑板条目携带 traceSpanId
 *
 * 内核不变量（违反即 CI 守护测试失败）：
 * - Agent 间通信必走 Blackboard（禁止直接读取他人 AgentContext）。
 * - 黑板条目 append-only：追加后 immutable，不可改写/删除他人条目。
 * - 每个 Agent 只能追加自己的条目（contributor = self.id）。
 * - 条目以结构化 JSON 存储（非自由文本注入提示词），防 Prompt 注入扩散。
 * - 每个条目携带 traceSpanId，可在 Trace 视图中定位结论产生的时间点与 Agent。
 * - 写入即固化到审计域（WORM）。
 *
 * 幂等：重试不重复追加已提交的结论条目（幂等键 = `(runId, agentId, conclusionHash)`）。
 */
import type { BlackboardEntry, BlackboardEntryType } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 结构化 Payload（对齐 detailed-design §4.6.2）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type BlackboardSeverity = 'info' | 'warn' | 'critical';
export type BlackboardRichType = 'finding' | 'risk' | 'evidence' | 'conclusion';

/**
 * 结构化 Payload —— 黑板条目的数据本体。
 * `summary` ≤200 字结构化摘要；`evidenceRef` 指向审计域证据 ID；
 * `confidence` ∈ [0,1]；`tags` 用于 Agent dispatch 时按需过滤读取。
 */
export interface BlackboardEntryPayload {
  summary: string;
  evidenceRef: string[];
  confidence: number;
  tags: string[];
  severity: BlackboardSeverity;
}

/**
 * 追加命令 —— 由 Agent 通过 BlackboardService 提交。
 * `contributor` 必须为调用方自身的 agentId（由 service 侧强制，不可由调用方伪造他人）。
 */
export interface AppendBlackboardEntryCommand {
  runId: string;
  contributor: string; // agentId
  entryType: BlackboardRichType;
  payload: BlackboardEntryPayload;
  traceSpanId: string;
  /** M3 委托链归因（delegated-by），用于审计可追溯完整委托链 */
  delegatedBy?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 读取过滤
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface BlackboardReadFilter {
  entryType?: BlackboardRichType;
  severity?: BlackboardSeverity;
  tags?: string[];
  contributor?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 黑板快照（dispatch 时注入 AgentContext，受压缩策略管控）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface BlackboardSnapshot {
  blackboardSessionId: string;
  runId: string;
  entries: ReadonlyArray<BlackboardEntry>;
  takenAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 聚合根
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class BlackboardSession {
  private readonly entries: BlackboardEntry[] = [];
  /** 幂等键集合：(runId, agentId, conclusionHash) */
  private readonly idempotencyKeys = new Set<string>();
  private readonly createdAt: string;

  private constructor(
    public readonly blackboardSessionId: string,
    public readonly runId: string,
    createdAt: string,
  ) {
    this.createdAt = createdAt;
  }

  static create(blackboardSessionId: string, runId: string): BlackboardSession {
    return new BlackboardSession(blackboardSessionId, runId, new Date().toISOString());
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 不变量校验
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 追加条目（append-only，唯一写入入口）。
   * - contributor 必须由调用方提供自身 agentId（service 侧校验，不可伪造他人）。
   * - 不可修改/删除既有条目。
   * - 幂等：重复 conclusionHash 返回已存在条目 ID，不重复追加。
   */
  append(cmd: AppendBlackboardEntryCommand): { entry: BlackboardEntry; appended: boolean } {
    this.assertInvariant(cmd);
    const idempotencyKey = this.buildIdempotencyKey(cmd.contributor, cmd.payload);
    if (this.idempotencyKeys.has(idempotencyKey)) {
      const existing = this.entries.find((e) => e.agentId === cmd.contributor && this.matchIdempotency(e, idempotencyKey));
      // 幂等命中：返回既有条目，不重复追加
      return { entry: existing ?? this.toEntry(cmd), appended: false };
    }

    const entry = this.toEntry(cmd);
    this.entries.push(entry);
    this.idempotencyKeys.add(idempotencyKey);
    return { entry, appended: true };
  }

  /**
   * 读取黑板快照（供 Agent dispatch 注入）。
   * 仅返回结构化条目，**绝不暴露任何 AgentContext**——Agent 间信息交换只走黑板。
   */
  read(filter?: BlackboardReadFilter): BlackboardSnapshot {
    const filtered = filter ? this.entries.filter((e) => this.matches(e, filter)) : this.entries;
    return {
      blackboardSessionId: this.blackboardSessionId,
      runId: this.runId,
      entries: filtered.map((e) => ({ ...e })),
      takenAt: new Date().toISOString(),
    };
  }

  /** 条目计数（L1 Trace 指标：entryCount / criticalCount / contributors） */
  stats(): {
    entryCount: number;
    criticalCount: number;
    contributors: string[];
  } {
    const contributors = new Set<string>();
    let criticalCount = 0;
    for (const e of this.entries) {
      contributors.add(e.agentId);
      if ((e.payload as unknown as BlackboardEntryPayload).severity === 'critical') criticalCount++;
    }
    return { entryCount: this.entries.length, criticalCount, contributors: [...contributors] };
  }

  getEntries(): ReadonlyArray<BlackboardEntry> {
    return this.entries;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 私有：不变量与映射
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private assertInvariant(cmd: AppendBlackboardEntryCommand): void {
    if (!cmd.contributor) {
      throw new Error('Blackboard invariant violation: contributor (agentId) is required');
    }
    if (!cmd.traceSpanId) {
      throw new Error('Blackboard invariant violation: traceSpanId is required on every entry (DES-4.3)');
    }
    if (cmd.payload.summary.length > 200) {
      throw new Error('Blackboard invariant violation: summary must be <= 200 chars (structured, anti-injection)');
    }
    if (cmd.payload.confidence < 0 || cmd.payload.confidence > 1) {
      throw new Error('Blackboard invariant violation: confidence must be within [0, 1]');
    }
    if (cmd.runId !== this.runId) {
      throw new Error('Blackboard invariant violation: entry.runId must match session.runId');
    }
    // 结构化 JSON 校验：payload 必须为对象，禁止字符串自由文本
    if (!cmd.payload || typeof cmd.payload !== 'object') {
      throw new Error('Blackboard invariant violation: payload must be structured JSON object');
    }
  }

  private toEntry(cmd: AppendBlackboardEntryCommand): BlackboardEntry {
    const payload: BlackboardEntryPayload = {
      summary: cmd.payload.summary,
      evidenceRef: cmd.payload.evidenceRef,
      confidence: cmd.payload.confidence,
      tags: cmd.payload.tags,
      severity: cmd.payload.severity,
      ...(cmd.delegatedBy ? { delegatedBy: cmd.delegatedBy } : {}),
    };
    return {
      entryId: this.genEntryId(),
      runId: cmd.runId,
      agentId: cmd.contributor,
      type: this.mapType(cmd.entryType) as BlackboardEntryType,
      payload: payload as unknown as Record<string, unknown>,
      traceSpanId: cmd.traceSpanId,
      timestamp: new Date().toISOString(),
    };
  }

  private mapType(t: BlackboardRichType): BlackboardEntryType {
    switch (t) {
      case 'conclusion':
        return 'conclusion';
      case 'risk':
        return 'risk';
      case 'evidence':
        return 'evidence';
      case 'finding':
      default:
        return 'summary';
    }
  }

  private matches(e: BlackboardEntry, f: BlackboardReadFilter): boolean {
    const p = e.payload as unknown as BlackboardEntryPayload;
    if (f.contributor && e.agentId !== f.contributor) return false;
    if (f.severity && p.severity !== f.severity) return false;
    if (f.tags && f.tags.length > 0 && !f.tags.every((t) => p.tags.includes(t))) return false;
    if (f.entryType) {
      // 富类型与 shared.type 的映射反查
      const rich = this.unmapType(e.type);
      if (rich !== f.entryType) return false;
    }
    return true;
  }

  private unmapType(t: BlackboardEntryType): BlackboardRichType {
    switch (t) {
      case 'conclusion':
        return 'conclusion';
      case 'risk':
        return 'risk';
      case 'evidence':
        return 'evidence';
      case 'summary':
      default:
        return 'finding';
    }
  }

  private buildIdempotencyKey(agentId: string, payload: BlackboardEntryPayload): string {
    const conclusionHash = this.hashSummary(payload.summary);
    return `${this.runId}|${agentId}|${conclusionHash}`;
  }

  private matchIdempotency(e: BlackboardEntry, key: string): boolean {
    const p = e.payload as unknown as BlackboardEntryPayload;
    return this.buildIdempotencyKey(e.agentId, p) === key;
  }

  private hashSummary(summary: string): string {
    // 轻量确定性哈希（非加密用途），用于幂等键。
    let h = 5381;
    for (let i = 0; i < summary.length; i++) {
      h = (h * 33) ^ summary.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }

  private genEntryId(): string {
    return `bb_${this.blackboardSessionId}_${this.entries.length}_${Date.now().toString(36)}`;
  }
}
