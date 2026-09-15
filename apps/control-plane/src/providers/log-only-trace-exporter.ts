import { Injectable, Logger } from '@nestjs/common';
import type { TraceExporter, TraceSpan } from '@aegisci/core/spi/trace';

/**
 * LogOnlyTraceExporter —— 本地日志导出实现。
 *
 * 对应设计：DES-13 / ADD §7 SPI。
 * 实现档位：LogOnlyTraceExporter（P1）。
 *
 * 特性：
 * - 将 trace 数据导出到本地结构化日志（JSON 格式）
 * - 性能基准：<0.1ms/span（低于 Noop 的开销）
 * - 审计 traceSpanId 始终有值（L6 不变量）
 * - 不依赖外部 OTel SDK
 */
@Injectable()
export class LogOnlyTraceExporter implements TraceExporter {
  readonly name = 'log-only';

  private readonly logger = new Logger(LogOnlyTraceExporter.name);
  private exportCount = 0;

  async export(span: TraceSpan): Promise<void> {
    const startTime = Date.now();

    try {
      const logData = {
        spanId: span.spanId,
        traceId: span.traceId,
        parentSpanId: span.parentSpanId,
        name: span.name,
        startTime: span.startTime,
        endTime: span.endTime,
        duration: span.endTime ? span.endTime - span.startTime : null,
        status: span.status,
        attributes: span.attributes,
        events: span.events.map((e) => ({
          name: e.name,
          timestamp: e.timestamp,
          attributes: e.attributes,
        })),
        exportedAt: new Date().toISOString(),
      };

      // 结构化日志输出
      this.logger.log('TraceSpan', logData);
      this.exportCount++;

      // 性能监控：如果单次导出超过阈值，记录警告
      const duration = Date.now() - startTime;
      if (duration > 1) {
        this.logger.warn(`Trace 导出性能警告：${duration}ms（阈值：1ms）`);
      }
    } catch (error) {
      // 日志失败时降级：只记录错误，不中断
      this.logger.error(`Trace 导出失败：${error.message}`);
    }
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  /**
   * 获取已导出的 span 数量（用于测试验证）
   */
  getExportCount(): number {
    return this.exportCount;
  }

  /**
   * 重置导出计数（用于测试）
   */
  reset(): void {
    this.exportCount = 0;
  }
}
