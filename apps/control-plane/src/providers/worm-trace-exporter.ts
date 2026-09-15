import type { TraceExporter, TraceSpan } from '@aegisci/core/spi/trace';

/**
 * WormTraceExporter —— Trace 入 WORM 审计导出器（hardened 档位）。
 *
 * 不变量（DES-13.9 / FR-M7-15）：
 * - Trace span 写入审计域（S3 Object Lock），与 WORM 审计记录反向关联
 * - fire-and-forget，不阻塞主链路
 * - 导出失败降级为日志，不影响内核追踪构建
 */
export class WormTraceExporter implements TraceExporter {
  readonly name = 'worm';

  private readonly auditLog: Array<{ span: TraceSpan; exportedAt: number }> = [];

  async export(span: TraceSpan): Promise<void> {
    // fire-and-forget：写入内存审计日志（生产环境对接 S3 Object Lock）
    this.auditLog.push({ span, exportedAt: Date.now() });

    // 异步持久化（模拟 S3 Object Lock 写入）
    setImmediate(() => {
      try {
        this.persist(span);
      } catch (err) {
        // 降级为日志：不阻塞主链路
        console.error(
          `[WormTraceExporter] persist failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  /**
   * 获取已导出的 span 列表（用于测试验证）
   */
  getExportedSpans(): ReadonlyArray<{ span: TraceSpan; exportedAt: number }> {
    return [...this.auditLog];
  }

  private persist(span: TraceSpan): void {
    // 生产实现：写入 S3 Object Lock
    // POC 级别：仅内存存储
    const record = JSON.stringify({
      traceId: span.traceId,
      spanId: span.spanId,
      name: span.name,
      exportedAt: new Date(span.startTime).toISOString(),
      status: span.status,
    });
    // 写入审计日志（已在 export 中添加，此处仅记录持久化动作）
    void record;
  }
}
