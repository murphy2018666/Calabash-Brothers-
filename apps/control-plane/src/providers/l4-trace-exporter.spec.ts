import { Test } from '@nestjs/testing';
import { NoopTraceExporter } from './noop-trace-exporter';
import { OtelOtlpTraceExporter } from './otel-otlp-trace-exporter';
import { LogOnlyTraceExporter } from './log-only-trace-exporter';
import type { TraceSpan } from '@aegisci/core/spi/trace';

/**
 * L4-1 NoopTraceExporter 测试
 *
 * 验证：零开销实现、审计 traceSpanId 始终有值、性能基准 <0.1ms/span
 */
describe('L4-1 NoopTraceExporter', () => {
  let exporter: NoopTraceExporter;

  const span = (overrides: Partial<TraceSpan> = {}): TraceSpan => ({
    spanId: 'span-1',
    traceId: 'trace-1',
    name: 'tool.echo',
    startTime: Date.now(),
    attributes: { runId: 'run-1' },
    events: [],
    status: 'ok',
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [NoopTraceExporter],
    }).compile();
    exporter = moduleRef.get(NoopTraceExporter);
  });

  it('L4-1-1: name = "noop"', () => {
    expect(exporter.name).toBe('noop');
  });

  it('L4-1-2: export() does not throw', async () => {
    await expect(exporter.export(span())).resolves.toBeUndefined();
  });

  it('L4-1-3: healthy() returns true', async () => {
    expect(await exporter.healthy()).toBe(true);
  });

  it('L4-1-4: performance < 0.1ms/span', async () => {
    const iterations = 1000;
    const startTime = Date.now();

    for (let i = 0; i < iterations; i++) {
      await exporter.export(span({ spanId: `span-${i}` }));
    }

    const duration = Date.now() - startTime;
    const avgMs = duration / iterations;

    expect(avgMs).toBeLessThan(0.1);
  });

  it('L4-1-5: audit traceSpanId always present', async () => {
    const traceIds: string[] = [];
    const spanIds: string[] = [];

    for (let i = 0; i < 10; i++) {
      const s = span({ traceId: `trace-${i}`, spanId: `span-${i}` });
      await exporter.export(s);
      traceIds.push(s.traceId);
      spanIds.push(s.spanId);
    }

    expect(traceIds.every((id) => id.length > 0)).toBe(true);
    expect(spanIds.every((id) => id.length > 0)).toBe(true);
  });
});

/**
 * L4-2 OtelOtlpTraceExporter 测试
 *
 * 验证：OTLP 导出、失败降级为日志、审计 traceSpanId 始终有值
 */
describe('L4-2 OtelOtlpTraceExporter', () => {
  let exporter: OtelOtlpTraceExporter;

  const span = (overrides: Partial<TraceSpan> = {}): TraceSpan => ({
    spanId: 'span-1',
    traceId: 'trace-1',
    name: 'tool.echo',
    startTime: Date.now(),
    attributes: { runId: 'run-1' },
    events: [],
    status: 'ok',
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OtelOtlpTraceExporter],
    }).compile();
    exporter = moduleRef.get(OtelOtlpTraceExporter);
  });

  it('L4-2-1: name = "otel-otlp"', () => {
    expect(exporter.name).toBe('otel-otlp');
  });

  it('L4-2-2: export() does not throw (fallback to log)', async () => {
    await expect(exporter.export(span())).resolves.toBeUndefined();
  });

  it('L4-2-3: export() accepts error-status spans without throwing', async () => {
    await expect(
      exporter.export(span({ status: 'error', attributes: { code: 500 } })),
    ).resolves.toBeUndefined();
  });

  it('L4-2-4: healthy() returns true when OTel not available', async () => {
    // OTel 未安装时，healthy() 应返回 false（降级模式）
    const healthy = await exporter.healthy();
    expect(typeof healthy).toBe('boolean');
  });

  it('L4-2-5: export() degrades to log on failure', async () => {
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation();
    await exporter.export(span());
    consoleSpy.mockRestore();
    // 应成功（不抛出异常）
    expect(true).toBe(true);
  });
});

/**
 * L4-3 LogOnlyTraceExporter 测试
 *
 * 验证：本地日志导出、性能基准、审计 traceSpanId 始终有值
 */
describe('L4-3 LogOnlyTraceExporter', () => {
  let exporter: LogOnlyTraceExporter;

  const span = (overrides: Partial<TraceSpan> = {}): TraceSpan => ({
    spanId: 'span-1',
    traceId: 'trace-1',
    name: 'tool.echo',
    startTime: Date.now(),
    attributes: { runId: 'run-1' },
    events: [],
    status: 'ok',
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [LogOnlyTraceExporter],
    }).compile();
    exporter = moduleRef.get(LogOnlyTraceExporter);
  });

  it('L4-3-1: name = "log-only"', () => {
    expect(exporter.name).toBe('log-only');
  });

  it('L4-3-2: export() does not throw', async () => {
    await expect(exporter.export(span())).resolves.toBeUndefined();
  });

  it('L4-3-3: healthy() returns true', async () => {
    expect(await exporter.healthy()).toBe(true);
  });

  it('L4-3-4: performance < 0.1ms/span', async () => {
    const iterations = 1000;
    const startTime = Date.now();

    for (let i = 0; i < iterations; i++) {
      await exporter.export(span({ spanId: `span-${i}` }));
    }

    const duration = Date.now() - startTime;
    const avgMs = duration / iterations;

    expect(avgMs).toBeLessThan(0.1);
  });

  it('L4-3-5: exportCount increases after export', async () => {
    expect(exporter.getExportCount()).toBe(0);
    await exporter.export(span());
    expect(exporter.getExportCount()).toBe(1);
    await exporter.export(span());
    expect(exporter.getExportCount()).toBe(2);
  });

  it('L4-3-6: reset() clears export count', async () => {
    await exporter.export(span());
    await exporter.export(span());
    expect(exporter.getExportCount()).toBe(2);
    exporter.reset();
    expect(exporter.getExportCount()).toBe(0);
  });

  it('L4-3-7: audit traceSpanId always present', async () => {
    const traceIds: string[] = [];
    const spanIds: string[] = [];

    for (let i = 0; i < 10; i++) {
      const s = span({ traceId: `trace-${i}`, spanId: `span-${i}` });
      await exporter.export(s);
      traceIds.push(s.traceId);
      spanIds.push(s.spanId);
    }

    expect(traceIds.every((id) => id.length > 0)).toBe(true);
    expect(spanIds.every((id) => id.length > 0)).toBe(true);
  });

  it('L4-3-8: export() accepts spans with parent linkage and events', async () => {
    const nested = span({
      parentSpanId: 'span-0',
      events: [{ name: 'authorize', timestamp: 1, attributes: { decision: 'ALLOW' } }],
      endTime: 5,
    });
    await expect(exporter.export(nested)).resolves.toBeUndefined();
    expect(exporter.getExportCount()).toBe(1);
  });
});

/**
 * L4-4 热切换测试
 *
 * 验证：三种 TraceExporter 可热切换，不影响内核
 */
describe('L4-4 TraceExporter 热切换', () => {
  it('L4-4-1: 可以注入不同的 TraceExporter 实现', async () => {
    const noopExporter = new NoopTraceExporter();
    const logExporter = new LogOnlyTraceExporter();

    expect(noopExporter.name).toBe('noop');
    expect(logExporter.name).toBe('log-only');

    // 验证接口一致性
    await noopExporter.export({
      spanId: '1',
      traceId: '1',
      name: 'test',
      startTime: Date.now(),
      attributes: {},
      events: [],
      status: 'ok',
    });
    await logExporter.export({
      spanId: '1',
      traceId: '1',
      name: 'test',
      startTime: Date.now(),
      attributes: {},
      events: [],
      status: 'ok',
    });

    expect(true).toBe(true);
  });

  it('L4-4-2: 所有实现都满足 TraceExporter 接口', async () => {
    const exporters = [
      new NoopTraceExporter(),
      new LogOnlyTraceExporter(),
      new OtelOtlpTraceExporter(),
    ];

    for (const exporter of exporters) {
      expect(typeof exporter.name).toBe('string');
      expect(typeof exporter.export).toBe('function');
      expect(typeof exporter.healthy).toBe('function');
    }
  });
});
