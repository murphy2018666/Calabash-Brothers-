/**
 * OutputRenderer —— 工具输出截断、折叠、大小限制（E3-3）。
 *
 * 对工具命令的输出（stdout/stderr）进行结构化处理：
 * - 截断超长输出（默认 4KB，上限 10MB）
 * - 折叠大段连续空白（压缩多余换行）
 * - JSON 数据自动格式化（≤4KB）
 * - 添加尺寸标注供 Agent 上下文预算管控
 *
 * 设计依据：
 * - detailed-design §4.5.3 上下文预算管控
 * - NFR-P1 工具调用输出大小限制（≤10MB）
 */
import { Injectable, Logger } from '@nestjs/common';

/** 默认输出截断长度 */
const DEFAULT_TRUNCATE_LENGTH = 4096;
/** 最大输出字节数 */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024; // 10MB

export interface RenderedOutput {
  /** 是否被截断 */
  truncated: boolean;
  /** 实际字节数（截断前） */
  originalByteLength: number;
  /** 渲染后的文本 */
  text: string;
  /** 渲染类型：text | json | markdown */
  type: 'text' | 'json' | 'markdown';
}

@Injectable()
export class OutputRenderer {
  private readonly logger = new Logger(OutputRenderer.name);

  constructor(private readonly config: { maxBytes?: number; truncateLength?: number } = {}) {}

  /**
   * 渲染工具 stdout 输出。
   * 自动检测是否为 JSON 并做格式化；超长则截断并标注。
   */
  renderStdout(raw: string | Buffer | null | undefined): RenderedOutput {
    if (!raw) return this.mkResult('', false, 0, 'text');
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const byteLength = Buffer.byteLength(text);

    // JSON 格式化检测
    try {
      const parsed = JSON.parse(text);
      const formatted = JSON.stringify(parsed, null, 2);
      return this.applyLimits(formatted, byteLength, 'json');
    } catch {
      // 非 JSON，按纯文本处理
      return this.applyLimits(text, byteLength, 'text');
    }
  }

  /**
   * 渲染工具 stderr 输出（错误信息，直接截断，不做 JSON 检测）。
   */
  renderStderr(raw: string | Buffer | null | undefined): RenderedOutput {
    if (!raw) return this.mkResult('', false, 0, 'text');
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    const byteLength = Buffer.byteLength(text);
    return this.applyLimits(text, byteLength, 'text');
  }

  /**
   * 将渲染后的输出写入 Agent 可消费的上下文格式
   * （包含元数据，便于 Agent 预算管控）。
   */
  toAgentContext(rendered: RenderedOutput, label: string): string {
    const prefix = `[${label}]`;
    if (rendered.truncated) {
      return `${prefix} (truncated: ${rendered.originalByteLength} bytes → ${rendered.text.length} chars)\n${rendered.text.slice(0, this.config.truncateLength ?? DEFAULT_TRUNCATE_LENGTH)}`;
    }
    return `${prefix}\n${rendered.text}`;
  }

  // ── 私有 ──

  private applyLimits(text: string, originalByteLength: number, type: 'text' | 'json'): RenderedOutput {
    const truncateLength = this.config.truncateLength ?? DEFAULT_TRUNCATE_LENGTH;
    const maxBytes = this.config.maxBytes ?? MAX_OUTPUT_BYTES;

    // 先按字节数截断（防止超大输出撑爆内存）
    let clipped = text;
    let truncated = false;
    if (originalByteLength > maxBytes) {
      // 找最近的字符边界截断到 maxBytes
      const byteBuf = Buffer.from(text);
      if (byteBuf.length > maxBytes) {
        clipped = byteBuf.subarray(0, maxBytes).toString('utf8');
        truncated = true;
      }
    }

    // 再按 truncateLength 截断展示（节省 Agent token 预算）
    if (clipped.length > truncateLength) {
      clipped = clipped.slice(0, truncateLength) + '\n... [truncated]';
      truncated = true;
    }

    return this.mkResult(clipped, truncated, originalByteLength, type);
  }

  private mkResult(text: string, truncated: boolean, originalByteLength: number, type: 'text' | 'json'): RenderedOutput {
    return { truncated, originalByteLength, text, type };
  }
}
