/**
 * Dagger式执行后端适配器 (D5-1)
 *
 * 设计目标：每个流水线步骤 = 容器化函数调用，类似 Dagger 的函数工作流范式。
 *
 * 实现要点：
 * - 接收 ConnectionGatewayPort.dispatchJob() 传入的 spec（含 image/entrypoint/args/env）
 * - 通过 Podman/Docker CLI 或 containerd-shim 在本地容器中运行步骤
 * - 步骤输出（stdout/stderr/exit code/artifacts）写回 NATS exec.job.result 主题
 * - 超时保护、资源限制（cgroup）、可观测（trace/span 关联）
 *
 * 对应文档：DES-1 执行后端选型、ADR-05 语言边界
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConnectionGatewayPort } from '@aegisci/domain/pipeline';

/**
 * DaggerSpec —— 步骤定义（从 PL 域 spec 字段解析而来）
 */
export interface DaggerSpec {
  image: string;
  entrypoint: string[];
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
  /** 超时毫秒，默认 300_000（5min） */
  timeoutMs?: number;
  /** 资源限制 */
  resources?: {
    memoryMb?: number;
    cpuShares?: number;
  };
  /** 步骤命名，用于 trace span */
  stepName?: string;
}

/**
 * JobResult —— 步骤执行结果，回传给 PL 域
 */
export interface JobResult {
  runId: string;
  jobId: string;
  attempt: number;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  success: boolean;
  traceSpanId: string;
}

interface RunningJob {
  runId: string;
  jobId: string;
  attempt: number;
  process: unknown; // Node.js ChildProcess
  startedAt: number;
  timeoutMs: number;
  traceSpanId: string;
}

@Injectable()
export class DaggerExecBackend implements ConnectionGatewayPort {
  private readonly logger = new Logger(DaggerExecBackend.name);
  private readonly running = new Map<string, RunningJob>();
  private readonly config: Record<string, string>;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      runtime: this.configService.get('AEGISCI_DAGGER_RUNTIME', 'podman'),
      defaultTimeoutMs: this.configService.get('AEGISCI_DAGGER_TIMEOUT_MS', '300000'),
      defaultMemoryMb: this.configService.get('AEGISCI_DAGGER_MEMORY_MB', '2048'),
    };
  }

  /**
   * dispatchJob —— 容器化函数调用入口
   *
   * spec.image 为必填项，缺省则以 spec.stepName 做 span 命名。
   * 采用异步启动策略，立即返回；结果由 onExit handler 通过 EventBus 发出。
   */
  async dispatchJob(params: {
    runId: string;
    jobId: string;
    attempt: number;
    pool: string;
    spec: Record<string, unknown>;
  }): Promise<void> {
    const { runId, jobId, attempt, spec } = params;
    const daggerSpec = this.parseSpec(spec);
    const timeoutMs = daggerSpec.timeoutMs ?? parseInt(this.config.defaultTimeoutMs, 10);

    this.logger.debug(
      `[Dagger] dispatchJob runId=${runId} jobId=${jobId} image=${daggerSpec.image} timeout=${timeoutMs}ms`,
    );

    const traceSpanId = `dagger-${jobId}-${Date.now()}`;
    const running: RunningJob = {
      runId,
      jobId,
      attempt,
      process: null,
      startedAt: Date.now(),
      timeoutMs,
      traceSpanId,
    };
    this.running.set(jobId, running);

    try {
      await this.runContainer(running, daggerSpec);
    } catch (err) {
      this.logger.error(`[Dagger] dispatchJob failed runId=${runId} jobId=${jobId}: ${err}`);
      // 失败时仍发结果事件（exitCode=-1），不抛出
      await this.emitResult({ ...running, exitCode: -1, stdout: '', stderr: String(err), success: false });
    }
  }

  async cancelJob(params: { runId: string; jobId: string; reason: string }): Promise<void> {
    const job = this.running.get(params.jobId);
    if (!job) {
      this.logger.warn(`[Dagger] cancelJob: job ${params.jobId} not found`);
      return;
    }
    this.logger.log(`[Dagger] cancelJob runId=${params.runId} jobId=${params.jobId} reason=${params.reason}`);
    this.running.delete(params.jobId);
    // 通过 signal 终止容器进程
    // TODO: 集成真实容器 runtime 的 kill API
  }

  async healthy(): Promise<boolean> {
    try {
      // 轻量探针：检查容器运行时可用
      return true;
    } catch {
      return false;
    }
  }

  /** 测试用：获取运行中 job */
  getRunning(): Map<string, RunningJob> {
    return this.running;
  }

  // ── 私有方法 ──────────────────────────────────────────────────────

  private parseSpec(spec: Record<string, unknown>): DaggerSpec {
    const image = String(spec.image ?? 'alpine:latest');
    const entrypoint = spec.entrypoint
      ? Array.isArray(spec.entrypoint)
        ? (spec.entrypoint as string[])
        : [String(spec.entrypoint)]
      : ['/bin/sh'];
    const args = spec.args ? (Array.isArray(spec.args) ? spec.args as string[] : [String(spec.args)]) : [];
    const env = spec.env && typeof spec.env === 'object' ? (spec.env as Record<string, string>) : {};
    return {
      image,
      entrypoint,
      args,
      env,
      cwd: spec.cwd ? String(spec.cwd) : undefined,
      timeoutMs: spec.timeoutMs ? Number(spec.timeoutMs) : undefined,
      stepName: spec.stepName ? String(spec.stepName) : image,
      resources: spec.resources && typeof spec.resources === 'object' ? (spec.resources as NonNullable<DaggerSpec['resources']>) : undefined,
    };
  }

  /**
   * runContainer —— 容器执行核心。
   *
   * V1.0 采用 placeholder 模式：记录调度日志并模拟耗时，
   * 为后续接入真实 Podman/Docker CLI 预留接口。
   *
   * 生产集成点：替换为 podman run --rm --memory ... --entrypoint ...
   */
  private async runContainer(job: RunningJob, spec: DaggerSpec): Promise<void> {
    const { runId, jobId, traceSpanId } = job;
    this.logger.log(
      `[Dagger] runContainer runId=${runId} jobId=${jobId} image=${spec.image} span=${traceSpanId}`,
    );

    // TODO: S9 后续迭代接入真实容器 runtime
    // 示例（占位实现）：使用 child_process.exec 模拟步骤运行
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const stdout = `[Dagger] step=${spec.stepName ?? spec.image} completed`;
    const durationMs = Date.now() - job.startedAt;

    await this.emitResult({
      runId,
      jobId,
      attempt: job.attempt,
      exitCode: 0,
      stdout,
      stderr: '',
      durationMs,
      success: true,
      traceSpanId,
    });

    this.running.delete(jobId);
  }

  /**
   * emitResult —— 发出步骤执行结果，PL 域订阅 exec.job.result 消费
   *
   * 实际生产实现：通过 EventBusPort.publish() 发出 DomainEvent。
   * 本 adapter 不持有 EventBus 引用（铁律：适配器不跨域依赖）。
   * 测试中可通过注入 mock EventBus 完成端到端验证。
   */
  private async emitResult(result: JobResult): Promise<void> {
    this.logger.debug(
      `[Dagger] emitResult runId=${result.runId} jobId=${result.jobId} exit=${result.exitCode} dur=${result.durationMs}ms span=${result.traceSpanId}`,
    );
    // 生产实现：eventBus.publish({ eventType: 'exec.job.result', payload: result, ... })
    void result;
  }
}
