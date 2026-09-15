import { Test, TestingModule } from '@nestjs/testing';
import { WormTraceExporter } from './worm-trace-exporter';
import type { TraceSpan } from '@aegisci/core/spi/trace';

describe('WormTraceExporter', () => {
  let exporter: WormTraceExporter;

  beforeEach(() => {
    exporter = new WormTraceExporter();
  });

  it('should have name = "worm"', () => {
    expect(exporter.name).toBe('worm');
  });

  it('should export span to in-memory audit log', async () => {
    const span: TraceSpan = {
      spanId: 'span-1',
      traceId: 'trace-1',
      name: 'test-span',
      startTime: Date.now(),
      attributes: {},
      events: [],
      status: 'ok',
    };

    await exporter.export(span);

    // 等待 fire-and-forget 执行
    await new Promise((r) => setTimeout(r, 10));

    const exported = exporter.getExportedSpans();
    expect(exported).toHaveLength(1);
    expect(exported[0].span.traceId).toBe('trace-1');
    expect(exported[0].span.spanId).toBe('span-1');
    expect(exported[0].exportedAt).toBeGreaterThan(0);
  });

  it('should export multiple spans', async () => {
    const spans: TraceSpan[] = [
      { spanId: 's1', traceId: 't1', name: 'span-a', startTime: Date.now(), attributes: {}, events: [], status: 'ok' },
      { spanId: 's2', traceId: 't2', name: 'span-b', startTime: Date.now(), attributes: {}, events: [], status: 'error' },
    ];

    for (const span of spans) {
      await exporter.export(span);
    }

    await new Promise((r) => setTimeout(r, 10));

    expect(exporter.getExportedSpans()).toHaveLength(2);
  });

  it('should return healthy = true', async () => {
    expect(await exporter.healthy()).toBe(true);
  });

  it('should handle export failure gracefully (fire-and-forget)', async () => {
    // 导出不应抛出异常
    const span: TraceSpan = {
      spanId: 's1',
      traceId: 't1',
      name: 'test',
      startTime: Date.now(),
      attributes: {},
      events: [],
      status: 'unset',
    };
    await expect(exporter.export(span)).resolves.toBeUndefined();
  });
});
