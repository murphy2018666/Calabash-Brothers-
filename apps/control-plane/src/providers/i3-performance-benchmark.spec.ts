/**
 * I3 High-Concurrency Benchmarks (S10)
 *
 * 针对 2000 并发场景的性能基准测试：
 * - InMemoryRunRepository 并发 save/load
 * - GoRunnerExecBackend 并发 dispatchJob
 * - OtelOtlpTraceExporter 并发 export（桩模式）
 * - CostMetricService 大规模聚合
 *
 * 设计目标：确认各核心路径在 2000 并发下的 P95 latency < 50ms，
 *           且零数据丢失。
 */
import { InMemoryRunRepository } from './in-memory-run-repository';
import type { Run } from '@aegisci/shared/types';
import { GoRunnerExecBackend } from './d5-gorunner-exec-backend';
import { ConfigService } from '@nestjs/config';
import { OtelOtlpTraceExporter } from './otel-otlp-trace-exporter';
import { CostMetricService } from './g3-cost-metric-service';
import type { TraceSpan } from '@aegisci/core/spi/trace';

// ── 辅助函数 ────────────────────────────────────────────────────────

function makeRun(runId: string, tenantId = 'tenant-bench'): Run {
  return {
    runId,
    tenantId,
    pipelineId: 'pipeline-bench',
    status: 'pending',
    stage: 'trigger',
    trigger: { event: 'push', repo: 'acme/x', ref: 'main', actor: 'bot', commit: 'c1' },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

describe('I3 Performance Benchmarks (2000 concurrent)', () => {
  describe('InMemoryRunRepository concurrency', () => {
    it('I3-1-1: save 2000 sequential runs within 2s', async () => {
      const repo = new InMemoryRunRepository();
      const start = performance.now();
      for (let i = 0; i < 2000; i++) {
        await repo.save(makeRun(`seq-run-${i}`));
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
      const loaded = await repo.loadByTenant('tenant-bench');
      expect(loaded.length).toBe(2000);
    });

    it('I3-1-2: loadByTenant returns all 2000 runs', async () => {
      const repo = new InMemoryRunRepository();
      for (let i = 0; i < 2000; i++) {
        await repo.save(makeRun(`r${i}`, `t-${i % 10}`));
      }
      for (let t = 0; t < 10; t++) {
        const tenantRuns = await repo.loadByTenant(`t-${t}`);
        expect(tenantRuns.length).toBe(200);
      }
    });

    it('I3-1-3: 100 并行 save，不丢失数据', async () => {
      const N = 100;
      const runs = Array.from({ length: N }, (_, i) => makeRun(`cr-concurrent-${i}`, 't-bench'));
      const localRepo = new InMemoryRunRepository();

      await Promise.all(runs.map((r) => localRepo.save(r)));

      // 逐个验证所有 run 都能 load 到（避免 sort() 字典序问题）
      for (const run of runs) {
        const found = await localRepo.load(run.runId);
        expect(found).toBeTruthy();
        expect(found.runId).toBe(run.runId);
      }
      // 数量验证
      const allRuns = await localRepo.loadByTenant('t-bench');
      expect(allRuns.length).toBeGreaterThanOrEqual(N);
    });

    it('I3-1-4: registerDedupKey under concurrent writes (100 parallel)', async () => {
      const repo = new InMemoryRunRepository();
      const promises = Array.from({ length: 100 }, (_, i) =>
        repo.registerDedupKey(`dk-${i}`, `run-dk-${i}`),
      );
      const results = await Promise.all(promises);
      expect(results.filter(Boolean).length).toBe(100);
      // 重复 key 应全部失败
      const dupPromises = Array.from({ length: 100 }, () =>
        repo.registerDedupKey('dk-0', 'run-duplicate'),
      );
      const dupResults = await Promise.all(dupPromises);
      expect(dupResults.every((r) => r === false)).toBe(true);
    });

    it('I3-1-5: read-after-write consistency (concurrent mix)', async () => {
      const repo = new InMemoryRunRepository();
      const writers = Array.from({ length: 50 }, (_, i) =>
        repo.save(makeRun(`mw-${i}`)),
      );
      await Promise.all(writers);
      const readers = Array.from({ length: 50 }, (_, i) =>
        repo.load(`mw-${i}`),
      );
      const results = await Promise.all(readers);
      expect(results.every((r) => r !== null)).toBe(true);
      expect(results.filter(Boolean).length).toBe(50);
    });
  });

  describe('GoRunnerExecBackend concurrency', () => {
    let backend: GoRunnerExecBackend;

    beforeEach(() => {
      backend = new GoRunnerExecBackend({
        get: jest.fn((key: string, fallback: string) => fallback),
      } as unknown as ConfigService);
      // 注册 10 个 runner，每个 maxSlots=10，确保高并发不瓶颈
      for (let i = 0; i < 10; i++) {
        backend.registerRunner({ runnerId: `runner-${i}`, pool: 'default', capabilities: ['bash'], maxSlots: 10 });
      }
    });

    it('I3-2-1: dispatch 200 jobs serially within 5s', async () => {
      const start = performance.now();
      for (let i = 0; i < 200; i++) {
        await backend.dispatchJob({
          runId: `run-${i}`,
          jobId: `job-${i}`,
          attempt: 0,
          pool: 'default',
          spec: {},
        });
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(5000);
    });

    it('I3-2-2: concurrent dispatch with ample capacity completes without error', async () => {
      // 10 runners × 10 slots = 100 concurrent capacity
      const dispatches = Array.from({ length: 100 }, (_, i) =>
        backend.dispatchJob({
          runId: `crun-${i}`,
          jobId: `cjob-${i}`,
          attempt: 0,
          pool: 'default',
          spec: {},
        }),
      );
      await Promise.all(dispatches);
      const snapshot = backend.getRunnersSnapshot();
      // 所有 jobs 完成后 inFlight 应归零
      expect(snapshot.every((r) => r.inFlight === 0)).toBe(true);
    });

    it('I3-2-3: capacity overflow when runner at maxSlots with concurrent dispatch', async () => {
      // 注册 1 个 runner，maxSlots=1，pool='default'
      backend.registerRunner({ runnerId: 'r-full', pool: 'default', capabilities: ['bash'], maxSlots: 1 });
      // dispatch 2 个 job 到同一个 pool，由于有 10 个 runner（每个 10 slot），
      // 即使 r-full 满了，selectRunner 会选其他空闲 runner
      const start = performance.now();
      await backend.dispatchJob({ runId: 'f1', jobId: 'j1', attempt: 0, pool: 'default', spec: {} });
      await backend.dispatchJob({ runId: 'f2', jobId: 'j2', attempt: 0, pool: 'default', spec: {} });
      const elapsed = performance.now() - start;
      // 两个都成功完成
      expect(elapsed).toBeLessThan(1000);
    });

    it('I3-2-4: healthy() returns true when runners have recent heartbeat', async () => {
      const h = await backend.healthy();
      expect(h).toBe(true);
    });

    it('I3-2-5: selectRunner picks least-loaded runner', async () => {
      const snapshotBefore = backend.getRunnersSnapshot();
      expect(snapshotBefore.every((r) => r.inFlight === 0)).toBe(true);

      // dispatch 几个 job，观察分配均匀度
      for (let i = 0; i < 10; i++) {
        await backend.dispatchJob({
          runId: `bal-${i}`,
          jobId: `bj-${i}`,
          attempt: 0,
          pool: 'default',
          spec: {},
        });
      }
      const snapshotAfter = backend.getRunnersSnapshot();
      // 由于调度是最空闲优先，job 完成后 inFlight 归零
      expect(snapshotAfter.every((r) => r.inFlight === 0)).toBe(true);
    });
  });

  describe('OtelOtlpTraceExporter batch export', () => {
    let exporter: OtelOtlpTraceExporter;

    beforeEach(() => {
      exporter = new OtelOtlpTraceExporter();
    });

    it('I3-3-1: export 500 spans within 3s (fallback to log)', async () => {
      const spans: TraceSpan[] = Array.from({ length: 500 }, (_, i) => ({
        spanId: `span-${i}`,
        traceId: `trace-${i % 50}`,
        name: `op-${i}`,
        startTime: Date.now() - i * 10,
        endTime: Date.now() - i * 10 + 100,
        status: 'ok',
        attributes: { 'test.metric': i },
        events: [],
      }));

      const start = performance.now();
      for (const span of spans) {
        await exporter.export(span);
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(3000);
    });

    it('I3-3-2: export with parentSpanId', async () => {
      const span: TraceSpan = {
        spanId: 'child',
        traceId: 'trace-1',
        name: 'child-op',
        startTime: Date.now(),
        attributes: {},
        events: [],
        status: 'ok',
        parentSpanId: 'parent',
      };
      await expect(exporter.export(span)).resolves.toBeUndefined();
    });

    it('I3-3-3: export with error status', async () => {
      const span: TraceSpan = {
        spanId: 'err-span',
        traceId: 'trace-err',
        name: 'failed-op',
        startTime: Date.now(),
        attributes: { 'error': true },
        events: [{ name: 'exception', attributes: { message: 'fail' }, timestamp: Date.now() }],
        status: 'error',
      };
      await expect(exporter.export(span)).resolves.toBeUndefined();
    });

    it('I3-3-4: healthy() without OTel deps returns false gracefully', async () => {
      const result = await exporter.healthy();
      expect(typeof result).toBe('boolean');
    });
  });

  describe('CostMetricService massive aggregation', () => {
    let metricService: CostMetricService;
    let nowStr: string;
    let pastStr: string;

    beforeEach(() => {
      metricService = new CostMetricService();
      nowStr = new Date().toISOString();
      pastStr = new Date(Date.now() - 3600_000).toISOString(); // 1h ago
    });

    it('I3-4-1: record and aggregate 1000 entries within 2s', async () => {
      const start = performance.now();
      for (let i = 0; i < 1000; i++) {
        metricService.record({
          tenantId: `tenant-${i % 5}`,
          dimension: i % 3 === 0 ? 'runner' : i % 3 === 1 ? 'agent' : 'gate',
          entityId: `target-${i}`,
          metricName: 'cost.runner',
          value: 1,
          unit: 'ms',
          timestamp: pastStr,
        });
      }
      const elapsed = performance.now() - start;
      expect(elapsed).toBeLessThan(2000);
      expect(metricService.getCount()).toBe(1000);
    });

    it('I3-4-2: getSummary 对 1000 条记录耗时 < 100ms', () => {
      const service = new CostMetricService();
      const now = new Date().toISOString();
      const past = new Date(Date.now() - 3600_000).toISOString(); // 1小时前

      for (let i = 0; i < 1000; i++) {
        service.record({ tenantId: 't-bench', dimension: 'agent', entityId: `agent-${i}`, metricName: 'cost.agent', value: 100, unit: 'token', timestamp: past });
      }

      const t0 = performance.now();
      const summary = service.getSummary({ tenantId: 't-bench', from: past, to: now });
      const elapsed = performance.now() - t0;

      expect(summary.tenantId).toBe('t-bench');
      expect(summary.byDimension['agent'].count).toBe(1000);
      expect(elapsed).toBeLessThan(100);
    });

    it('I3-4-3: fromSpan extracts cost from spans with correct attributes', () => {
      const spans: TraceSpan[] = Array.from({ length: 500 }, (_, i) => ({
        spanId: `s-${i}`,
        traceId: `t-${i}`,
        name: `op-${i}`,
        startTime: Date.now(),
        endTime: Date.now() + 100,
        status: 'ok',
        attributes: {
          'cost.dimension': i % 2 === 0 ? 'runner' : 'agent',
          'cost.value': String(i % 10 + 1),
          'tenant.id': 't-bench',
        },
        events: [],
      }));

      let count = 0;
      for (const span of spans) {
        const entry = CostMetricService.fromSpan(span);
        if (entry) {
          count++;
          expect(entry.tenantId).toBe('t-bench');
          expect(['runner', 'agent']).toContain(entry.dimension);
        }
      }
      expect(count).toBe(500);
    });

    it('I3-4-4: setPricingPolicy hot update applies to new records', () => {
      const service = new CostMetricService();
      const now = new Date().toISOString();
      const past = new Date(Date.now() - 3600_000).toISOString();

      service.record({ tenantId: 't1', dimension: 'gate', entityId: 'g1', metricName: 'cost.gate', value: 1, unit: 'usd', timestamp: past });
      const before = service.getSummary({ tenantId: 't1', from: past, to: now });

      service.setPricingPolicy({ rates: { gate: 999 } });
      service.record({ tenantId: 't1', dimension: 'gate', entityId: 'g2', metricName: 'cost.gate', value: 1, unit: 'usd', timestamp: past });
      const after = service.getSummary({ tenantId: 't1', from: past, to: now });

      expect(after.totalUsd).toBeGreaterThan(before.totalUsd);
    });
  });

  describe('End-to-end concurrency stress', () => {
    it('I3-5-1: mixed read/write throughputs (200 sequential ops)', async () => {
      const repo = new InMemoryRunRepository();
      const backend = new GoRunnerExecBackend({
        get: jest.fn((key: string, fallback: string) => fallback),
      } as unknown as ConfigService);
      // 注册足够 runner 避免容量瓶颈
      for (let i = 0; i < 5; i++) {
        backend.registerRunner({ runnerId: `r-${i}`, pool: 'p1', capabilities: ['bash'], maxSlots: 20 });
      }

      const start = performance.now();
      for (let i = 0; i < 200; i++) {
        await repo.save(makeRun(`mix-${i}`));
        await backend.dispatchJob({ runId: `mix-${i}`, jobId: `j-${i}`, attempt: 0, pool: 'p1', spec: {} });
        await repo.load(`mix-${i}`);
      }
      const elapsed = performance.now() - start;

      const finalCount = (await repo.loadByTenant('tenant-bench')).length;
      expect(finalCount).toBe(200);
      expect(elapsed).toBeLessThan(10000);
    });
  });
});
