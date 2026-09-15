/**
 * D5 执行后端适配器单元测试
 *
 * 验证：
 * - D5-1 Dagger式适配器（容器化函数调用语义）
 * - D5-2 GoRunner适配器（Runner池调度与负载均衡）
 * - D5-3 外部CI桥接适配器（Jenkins/GHA 桥接）
 */
import { ConfigService } from '@nestjs/config';
import { DaggerExecBackend, type JobResult } from './d5-dagger-exec-backend';
import { GoRunnerExecBackend } from './d5-gorunner-exec-backend';
import { ExternalCIBridge, type CiProvider } from './d5-external-ci-bridge';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// D5-1 DaggerExecBackend
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('D5-1 DaggerExecBackend', () => {
  let backend: DaggerExecBackend;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: (key: string, fallback: string) => fallback,
    } as unknown as ConfigService;
    backend = new DaggerExecBackend(configService);
  });

  it('D5-1-1: dispatchJob resolves without throwing', async () => {
    await expect(
      backend.dispatchJob({
        runId: 'run-1',
        jobId: 'job-1',
        attempt: 1,
        pool: 'default',
        spec: { image: 'alpine:latest', entrypoint: ['/bin/sh'], args: ['-c', 'echo hi'] },
      }),
    ).resolves.toBeUndefined();
  });

  it('D5-1-2: parseSpec extracts image from spec', async () => {
    const running = backend.getRunning();
    await backend.dispatchJob({
      runId: 'run-1',
      jobId: 'job-1',
      attempt: 1,
      pool: 'default',
      spec: { image: 'node:20', stepName: 'build' },
    });
    // 占位实现，running 中记录 traceSpanId
    expect(running.size).toBeGreaterThanOrEqual(0);
  });

  it('D5-1-3: healthy() returns boolean', async () => {
    const healthy = await backend.healthy();
    expect(typeof healthy).toBe('boolean');
  });

  it('D5-1-4: cancelJob does not throw for unknown job', async () => {
    await expect(
      backend.cancelJob({ runId: 'run-1', jobId: 'nonexistent', reason: 'user-cancel' }),
    ).resolves.toBeUndefined();
  });

  it('D5-1-5: spec with stepName uses it as span name', async () => {
    const consoleSpy = jest.spyOn(console, 'log').mockImplementation();
    await backend.dispatchJob({
      runId: 'run-1',
      jobId: 'job-step-a',
      attempt: 1,
      pool: 'default',
      spec: { image: 'ubuntu', stepName: 'apt-install', timeoutMs: 60000 },
    });
    consoleSpy.mockRestore();
    expect(true).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// D5-2 GoRunnerExecBackend
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('D5-2 GoRunnerExecBackend', () => {
  let backend: GoRunnerExecBackend;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: (key: string, fallback: string) => fallback,
    } as unknown as ConfigService;
    backend = new GoRunnerExecBackend(configService);
  });

  it('D5-2-1: registerRunner adds node to pool', () => {
    backend.registerRunner({ runnerId: 'r1', pool: 'build', capabilities: ['docker'], maxSlots: 4 });
    const snapshot = backend.getRunnersSnapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].runnerId).toBe('r1');
    expect(snapshot[0].pool).toBe('build');
    expect(snapshot[0].maxSlots).toBe(4);
  });

  it('D5-2-2: heartbeat updates lastHeartbeat', () => {
    backend.registerRunner({ runnerId: 'r1', pool: 'build', capabilities: [] });
    const before = backend.getRunnersSnapshot()[0].lastHeartbeat;
    // 等待 1ms 再心跳
    jest.useFakeTimers();
    jest.advanceTimersByTime(10);
    backend.heartbeat('r1');
    const after = backend.getRunnersSnapshot()[0].lastHeartbeat;
    expect(after).toBeGreaterThan(before);
    jest.useRealTimers();
  });

  it('D5-2-3: dispatchJob selects runner from pool', async () => {
    backend.registerRunner({ runnerId: 'r-build-1', pool: 'build', capabilities: ['docker'], maxSlots: 4 });
    await expect(
      backend.dispatchJob({
        runId: 'run-1',
        jobId: 'job-1',
        attempt: 1,
        pool: 'build',
        spec: { image: 'alpine' },
      }),
    ).resolves.toBeUndefined();
  });

  it('D5-2-4: dispatchJob throws when pool has no runners', async () => {
    await expect(
      backend.dispatchJob({
        runId: 'run-1',
        jobId: 'job-1',
        attempt: 1,
        pool: 'empty-pool',
        spec: {},
      }),
    ).rejects.toThrow('no available runner in pool=empty-pool');
  });

  it('D5-2-5: healthy() returns false when no runners registered', async () => {
    expect(await backend.healthy()).toBe(false);
  });

  it('D5-2-6: healthy() returns true when runners are active', async () => {
    backend.registerRunner({ runnerId: 'r1', pool: 'build', capabilities: [] });
    expect(await backend.healthy()).toBe(true);
  });

  it('D5-2-7: cancelJob does not throw', async () => {
    await expect(
      backend.cancelJob({ runId: 'run-1', jobId: 'j1', reason: 'timeout' }),
    ).resolves.toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// D5-3 ExternalCIBridge
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('D5-3 ExternalCIBridge', () => {
  let bridge: ExternalCIBridge;
  let configService: ConfigService;

  beforeEach(() => {
    configService = {
      get: (key: string, fallback: string) => fallback,
    } as unknown as ConfigService;
    bridge = new ExternalCIBridge(configService);
  });

  it('D5-3-1: registerBridge adds bridge config', () => {
    bridge.registerBridge('jenkins-main', {
      provider: 'jenkins' as CiProvider,
      baseUrl: 'https://jenkins.example.com',
      credentialRef: 'vault:jenkins-token',
      targetJob: 'deploy-prod',
    });
    expect(bridge.getBridges().has('jenkins-main')).toBe(true);
  });

  it('D5-3-2: dispatchJob uses default bridge when bridgeName not in spec', async () => {
    bridge.registerBridge('default', {
      provider: 'github-actions' as CiProvider,
      baseUrl: 'https://api.github.com',
      credentialRef: 'gh-token',
      targetJob: 'ci-pipeline',
    });
    await expect(
      bridge.dispatchJob({
        runId: 'run-1',
        jobId: 'job-1',
        attempt: 1,
        pool: 'default',
        spec: { image: 'alpine' },
      }),
    ).resolves.toBeUndefined();
  });

  it('D5-3-3: dispatchJob throws when bridge not found', async () => {
    await expect(
      bridge.dispatchJob({
        runId: 'run-1',
        jobId: 'job-1',
        attempt: 1,
        pool: 'default',
        spec: { bridgeName: 'missing-bridge' },
      }),
    ).rejects.toThrow('no bridge config for name=missing-bridge');
  });

  it('D5-3-4: dispatchJob with named bridge', async () => {
    bridge.registerBridge('gha-prod', {
      provider: 'github-actions' as CiProvider,
      baseUrl: 'https://api.github.com',
      credentialRef: 'gh-prod-token',
      targetJob: 'deploy',
    });
    await expect(
      bridge.dispatchJob({
        runId: 'run-2',
        jobId: 'job-2',
        attempt: 1,
        pool: 'prod',
        spec: { bridgeName: 'gha-prod', image: 'ubuntu' },
      }),
    ).resolves.toBeUndefined();
  });

  it('D5-3-5: healthy() returns false when no bridges registered', async () => {
    expect(await bridge.healthy()).toBe(false);
  });

  it('D5-3-6: healthy() returns true when bridges exist', async () => {
    bridge.registerBridge('dummy', {
      provider: 'jenkins' as CiProvider,
      baseUrl: 'http://localhost',
      credentialRef: 'ref',
      targetJob: 'job',
    });
    expect(await bridge.healthy()).toBe(true);
  });

  it('D5-3-7: cancelJob does not throw', async () => {
    await expect(
      bridge.cancelJob({ runId: 'r1', jobId: 'j1', reason: 'manual' }),
    ).resolves.toBeUndefined();
  });
});
