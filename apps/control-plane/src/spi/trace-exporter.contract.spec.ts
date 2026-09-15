import { Test } from '@nestjs/testing';
import type { TraceSpan } from '@aegisci/core/spi/trace';
import { NoopTraceExporter } from '../providers/noop-trace-exporter';

/**
 * SPI 契约测试 —— NoopTraceExporter 实现 TraceExporter 接口正确性
 * （DES-13.9 / ADR-07：Noop 也要满足接口契约，零开销但不破坏证据链；
 * 即使选 Noop，内核仍生成 traceId + evidenceId 写入审计记录）。
 */
describe('NoopTraceExporter (TraceExporter SPI contract)', () => {
  let exporter: NoopTraceExporter;

  const span = (overrides: Partial<TraceSpan> = {}): TraceSpan => ({
    spanId: 'span-1',
    traceId: 'trace-1',
    name: 'tool.echo',
    startTime: 0,
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

  it('exposes name = "noop"', () => {
    expect(exporter.name).toBe('noop');
  });

  it('export() does not throw', async () => {
    await expect(exporter.export(span())).resolves.toBeUndefined();
  });

  it('healthy() returns true', async () => {
    expect(await exporter.healthy()).toBe(true);
  });

  // ── 扩展边界用例（L2-1）─────────────────────────────────

  it('export() accepts error-status spans without throwing', async () => {
    await expect(
      exporter.export(span({ status: 'error', attributes: { runId: 'run-2', code: 500 } })),
    ).resolves.toBeUndefined();
  });

  it('export() accepts spans with parent linkage and events (L4 span model)', async () => {
    const nested = span({
      parentSpanId: 'span-0',
      events: [{ name: 'authorize', timestamp: 1, attributes: { decision: 'ALLOW' } }],
      endTime: 5,
    });
    await expect(exporter.export(nested)).resolves.toBeUndefined();
  });

  it('export() is side-effect free (repeated export of same span is safe)', async () => {
    const s = span();
    await exporter.export(s);
    await exporter.export(s);
    // Noop 无状态：重复导出无异常（幂等语义）。
    await expect(exporter.export(s)).resolves.toBeUndefined();
  });
});
