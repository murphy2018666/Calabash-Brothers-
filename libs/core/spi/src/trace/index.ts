/**
 * TraceExporter SPI —— 链路追踪导出
 *
 * 不变量（DES-13.9 / ADD ADR-07）：
 * - Span 在内核构建（不可关闭），Exporter 只负责"输出到哪里"（可插拔）
 * - 即使选 Noop，内核仍生成 traceId + evidenceId 写入审计记录
 * - 审计→Trace 反向关联接口契约始终不变
 *
 * 实现档位：
 * - NoopTraceExporter  —— 零开销空实现（V1.0 默认）
 * - OtelOtlpTraceExporter —— OTel → Tempo/Jaeger（P1）
 * - LogOnlyTraceExporter —— traceId 写结构化日志（P1）
 * - WormTraceExporter —— Trace 入 WORM 审计（P2）
 */

export interface TraceSpan {
  spanId: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  startTime: number;
  endTime?: number;
  attributes: Record<string, string | number | boolean>;
  events: TraceSpanEvent[];
  status: 'unset' | 'ok' | 'error';
}

export interface TraceSpanEvent {
  name: string;
  timestamp: number;
  attributes: Record<string, string | number | boolean>;
}

export interface TraceExporter {
  /** 导出一个完成的 Span */
  export(span: TraceSpan): Promise<void>;

  /** 导出器名称 */
  readonly name: string;

  /** 健康检查 */
  healthy(): Promise<boolean>;
}
