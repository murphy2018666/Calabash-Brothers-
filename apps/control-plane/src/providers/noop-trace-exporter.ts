import { Injectable } from '@nestjs/common';
import type { TraceExporter, TraceSpan } from '@aegisci/core/spi/trace';

/**
 * NoopTraceExporter —— 零开销链路追踪导出（V1.0 默认，SPI 实现）。
 *
 * 对应设计：DES-13 实现档位 NoopTraceExporter / ADD §7 SPI。
 * 不变量（DES-13.9 / ADR-07）：即使选 Noop，内核仍生成 traceId + evidenceId
 * 写入审计记录 —— 本导出器只决定"不输出到外部后端"，不影响内核追踪构建。
 */
@Injectable()
export class NoopTraceExporter implements TraceExporter {
  readonly name = 'noop';

  async export(_span: TraceSpan): Promise<void> {
    // Noop: 立即返回，不输出到任何外部后端。
    return;
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}
