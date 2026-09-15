import { Injectable, Logger } from '@nestjs/common';
import type { TraceExporter, TraceSpan } from '@aegisci/core/spi/trace';

/**
 * OtelOtlpTraceExporter —— OpenTelemetry OTLP 导出实现。
 *
 * 对应设计：DES-13 / ADD §7 SPI。
 * 实现档位：OtelOtlpTraceExporter（P1）。
 *
 * 特性：
 * - 使用 OpenTelemetry SDK 导出 trace 到 OTLP 后端（Tempo/Jaeger）
 * - 导出失败降级为日志（不中断内核链路）
 * - 审计 traceSpanId 始终有值（L6 不变量）
 *
 * 注意：本实现依赖 @opentelemetry/sdk-trace-base 和
 * @opentelemetry/exporter-trace-otlp-http 等外部包，
 * 在生产环境中需安装这些依赖。
 */
@Injectable()
export class OtelOtlpTraceExporter implements TraceExporter {
  readonly name = 'otel-otlp';

  private readonly logger = new Logger(OtelOtlpTraceExporter.name);
  private readonly exporter?: any;
  private readonly tracer?: any;

  constructor() {
    // 延迟加载 OTel 依赖，避免在无 OTel 环境下启动失败
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const otlpExporter = require('@opentelemetry/exporter-trace-otlp-http');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sdk = require('@opentelemetry/sdk-trace-base');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const webPlugin = require('@opentelemetry/plugin-http');

      this.exporter = new otlpExporter.OTLPTraceExporter({
        url: process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318/v1/traces',
      });
      this.tracer = new sdk.TracerProvider({
        exporters: [this.exporter],
      }).getTracer('aegisci-trace');
    } catch (error) {
      this.logger.warn(
        `OtelOtlpTraceExporter 初始化失败（OTel 依赖未安装或配置错误）：${error.message}`,
      );
      this.exporter = undefined;
      this.tracer = undefined;
    }
  }

  async export(span: TraceSpan): Promise<void> {
    if (!this.tracer) {
      this.logger.debug(`OtelOtlpTraceExporter 未就绪，跳过导出 span: ${span.name}`);
      return;
    }

    try {
      const endTime = (span.endTime ?? Date.now()) / 1000;
      const startTime = span.startTime / 1000;

      const otelSpan = this.tracer.startSpan(span.name, {
        startTime: new Date(startTime * 1000),
        attributes: span.attributes,
      });

      if (span.parentSpanId) {
        otelSpan.setAttribute('parentSpanId', span.parentSpanId);
      }
      if (span.status === 'error') {
        otelSpan.setStatus({ code: 2, message: 'ERROR' });
      }

      for (const event of span.events) {
        otelSpan.addEvent(event.name, {
          ...event.attributes,
          timestamp: event.timestamp,
        });
      }

      otelSpan.end(new Date(endTime * 1000));
    } catch (error) {
      // 降级：导出失败时记录日志，不中断内核
      this.logger.error(`Trace 导出失败（降级为日志）：${error.message}`);
      this.logger.error(`Span 数据: ${JSON.stringify(span, null, 2)}`);
    }
  }

  async healthy(): Promise<boolean> {
    if (!this.exporter) {
      return false;
    }
    try {
      // 尝试导出一个空 span 来验证连接
      await this.export({
        spanId: 'health-check',
        traceId: 'health-check',
        name: 'health',
        startTime: Date.now(),
        attributes: {},
        events: [],
        status: 'ok',
      });
      return true;
    } catch {
      return false;
    }
  }
}
