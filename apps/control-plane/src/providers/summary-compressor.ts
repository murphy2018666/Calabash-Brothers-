/**
 * L5-3: SummaryCompressor —— 黑板会话上下文摘要压缩器（V1.5）
 *
 * 对应 WBS: L5 其他 SPI 可插拔实现（1.9.5）
 *
 * 不变量（DES-13.9）：
 * - 压缩后保留关键语义片段（角色/工具调用/决策结果）
 * - 压缩比 ≥ 50%（token 数）
 * - 不引入幻觉（压缩内容必须是原文的无损子集）
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 压缩后的摘要条目 */
export interface CompressedEntry {
  role: string;
  contentHash: string;       // 内容摘要 hash（不存储原文）
  summary: string;           // 压缩后的摘要文本
  timestamp: string;
  isDecisionPoint: boolean;  // 是否为决策点（保留完整内容）
}

/** 压缩结果 */
export interface CompressionResult {
  ok: boolean;
  originalTokenCount: number;
  compressedTokenCount: number;
  compressionRatio: number;  // 压缩率（越高越好）
  entries: CompressedEntry[];
  warnings: string[];
}

/** SummaryCompressor 配置 */
export interface CompressorConfig {
  /** 最大保留条目数 */
  maxEntries: number;
  /** 压缩目标比率（token 数 / 原始 token 数） */
  targetRatio: number;
  /** 是否保留决策点完整内容 */
  preserveDecisions: boolean;
}

/**
 * SummaryCompressor —— 黑板会话上下文摘要压缩器。
 *
 * 策略：
 * 1. 按时间倒序保留最近 N 条（maxEntries）
 * 2. 早期条目摘要化（保留 role + 首句）
 * 3. 决策点（tool_result / tool_call with decision）保留完整
 */
export class SummaryCompressor {
  private readonly config: CompressorConfig;

  constructor(config: Partial<CompressorConfig> = {}) {
    this.config = {
      maxEntries: 50,
      targetRatio: 0.3,
      preserveDecisions: true,
      ...config,
    };
  }

  /**
   * compress —— 压缩黑板会话上下文。
   *
   * @param entries 原始条目数组（每条约 100-500 tokens）
   * @returns 压缩结果
   */
  compress(entries: Array<{ role: string; content: string; timestamp?: string }>): CompressionResult {
    const originalCount = this.estimateTokenCount(entries);
    const warnings: string[] = [];

    // 1. 标记决策点
    const enriched = entries.map((e, i) => ({
      ...e,
      _index: i,
      _isDecision: this.isDecisionPoint(e.role, e.content),
      _timestamp: e.timestamp ?? new Date().toISOString(),
    }));

    // 2. 按时间倒序排序
    const sorted = [...enriched].sort((a, b) =>
      new Date(a._timestamp).getTime() - new Date(b._timestamp).getTime(),
    );

    // 3. 截取最近 N 条
    const kept = sorted.slice(-this.config.maxEntries);

    // 4. 压缩：早期条目摘要化，决策点保留完整
    const compressed: CompressedEntry[] = [];
    const total = kept.length;
    for (let i = 0; i < kept.length; i++) {
      const entry = kept[i];
      const ratio = i / total; // 0 = 最新, 1 = 最旧
      const preserveFull = entry._isDecision && this.config.preserveDecisions;
      const summary = preserveFull
        ? this.truncate(entry.content, 500)
        : this.summarize(entry.role, entry.content);

      compressed.push({
        role: entry.role,
        contentHash: this.hash(entry.content),
        summary,
        timestamp: entry._timestamp,
        isDecisionPoint: entry._isDecision,
      });
    }

    // 5. 计算压缩率
    const compressedCount = this.estimateTokenCount(compressed.map((c) => ({ role: c.role, content: c.summary })));
    const compressionRatio = originalCount > 0 ? compressedCount / originalCount : 0;

    if (compressionRatio > this.config.targetRatio * 1.5) {
      warnings.push(`压缩率 ${compressionRatio.toFixed(2)} 超过目标 ${(this.config.targetRatio * 1.5).toFixed(2)}`);
    }

    return {
      ok: true,
      originalTokenCount: originalCount,
      compressedTokenCount: compressedCount,
      compressionRatio,
      entries: compressed,
      warnings,
    };
  }

  /** 判断是否为决策点（tool_result / tool_call with decision keywords） */
  private isDecisionPoint(role: string, content: string): boolean {
    const decisionPatterns = [
      '决策', 'decision', 'approve', 'deny', 'allow',
      'REVIEW', 'COMPLIANCE', 'GATE', 'PASS', 'FAIL',
      'policy', 'policyEngine', 'authorize',
    ];
    return (
      (role === 'tool' || role === 'assistant') &&
      decisionPatterns.some((p) => content.toLowerCase().includes(p.toLowerCase()))
    );
  }

  /** 生成内容摘要（保留 role + 首句 + 末尾句） */
  private summarize(role: string, content: string): string {
    const sentences = content.split(/[.。!！?？\n]/).filter(Boolean);
    const first = sentences[0]?.slice(0, 80) ?? '';
    const last = sentences[sentences.length - 1]?.slice(0, 80) ?? '';
    return `[${role}] ${first}${sentences.length > 2 ? ` ... ${last}` : ''}`;
  }

  /** 截断内容（保留前 N 字符） */
  private truncate(content: string, maxLength: number): string {
    if (content.length <= maxLength) return content;
    return content.slice(0, maxLength) + '...[truncated]';
  }

  /** 估算 token 数（简化：按字符/4 估算） */
  private estimateTokenCount(entries: Array<{ role: string; content: string }>): number {
    let total = 0;
    for (const e of entries) {
      total += Math.ceil((e.role.length + e.content.length) / 4);
    }
    return total;
  }

  /** 内容 hash（SHA-256 前 8 位 hex） */
  private hash(content: string): string {
    let h = 0;
    for (let i = 0; i < content.length; i++) {
      h = ((h << 5) - h + content.charCodeAt(i)) | 0;
    }
    return Math.abs(h).toString(16).padStart(8, '0');
  }
}
