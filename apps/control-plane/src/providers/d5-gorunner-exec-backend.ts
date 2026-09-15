/**
 * GoRunner 执行后端适配器 (D5-2)
 *
 * 设计目标：轻量脚本代理，类似 Buildkite agent 的心智模型——
 * Runner 反向建立 mTLS gRPC 长连接，控制面按需派发 JobAssign。
 *
 * 本适配器作为控制面侧的"虚拟 Runner 管理器"，模拟多 Runner 池的
 * 调度与心跳管理，为未来接入真实 Go Runner 预留接口。
 *
 * 对应文档：DES-1 执行后端选型、ADR-05 语言边界、DES-3 CGW 上下文映射
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConnectionGatewayPort } from '@aegisci/domain/pipeline';

/**
 * RunnerNode —— 已注册的 Runner 节点信息
 */
export interface RunnerNode {
  runnerId: string;
  pool: string;
  /** Runner 注册时的能力声明（支持的 image/步骤类型） */
  capabilities: string[];
  lastHeartbeat: number;
  /** 当前 in-flight job 数 */
  inFlight: number;
  maxSlots: number;
}

/**
 * DispatcherIntent —— 派发给 Runner 的意图消息
 */
export interface DispatcherIntent {
  runId: string;
  jobId: string;
  attempt: number;
  pool: string;
  spec: Record<string, unknown>;
  traceSpanId: string;
}

@Injectable()
export class GoRunnerExecBackend implements ConnectionGatewayPort {
  private readonly logger = new Logger(GoRunnerExecBackend.name);
  /** Runner 节点池，以 runnerId 为 key */
  private readonly runners = new Map<string, RunnerNode>();
  /** pool → runnerIds 索引，加速按池分发 */
  private readonly poolIndex = new Map<string, Set<string>>();
  private readonly config: Record<string, string>;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      heartbeatTimeoutMs: this.configService.get('AEGISCI_RUNNER_HEARTBEAT_TIMEOUT_MS', '30000'),
      defaultMaxSlots: this.configService.get('AEGISCI_RUNNER_MAX_SLOTS', '4'),
    };
  }

  /**
   * registerRunner —— 模拟 Runner 反向建连注册
   * （生产实现：gRPC handler 接收 Runner 首次 connect 时调用）
   */
  registerRunner(params: {
    runnerId: string;
    pool: string;
    capabilities: string[];
    maxSlots?: number;
  }): void {
    const { runnerId, pool, capabilities, maxSlots } = params;
    const node: RunnerNode = {
      runnerId,
      pool,
      capabilities,
      lastHeartbeat: Date.now(),
      inFlight: 0,
      maxSlots: maxSlots ?? parseInt(this.config.defaultMaxSlots, 10),
    };
    this.runners.set(runnerId, node);
    const poolSet = this.poolIndex.get(pool) ?? new Set<string>();
    poolSet.add(runnerId);
    this.poolIndex.set(pool, poolSet);
    this.logger.log(`[GoRunner] registerRunner runnerId=${runnerId} pool=${pool} slots=${node.maxSlots}`);
  }

  /**
   * heartbeat —— Runner 心跳（模拟）
   */
  heartbeat(runnerId: string): void {
    const node = this.runners.get(runnerId);
    if (!node) {
      this.logger.warn(`[GoRunner] heartbeat: unknown runnerId=${runnerId}`);
      return;
    }
    node.lastHeartbeat = Date.now();
  }

  async dispatchJob(params: {
    runId: string;
    jobId: string;
    attempt: number;
    pool: string;
    spec: Record<string, unknown>;
  }): Promise<void> {
    const { runId, jobId, attempt, pool, spec } = params;
    const traceSpanId = `gorunner-${jobId}-${Date.now()}`;
    const intent: DispatcherIntent = { runId, jobId, attempt, pool, spec, traceSpanId };

    // 轮询选择池中最空闲的 Runner
    const runnerId = this.selectRunner(pool);
    if (!runnerId) {
      throw new Error(`[GoRunner] no available runner in pool=${pool} for job=${jobId}`);
    }

    const node = this.runners.get(runnerId);
    if (!node || node.inFlight >= node.maxSlots) {
      throw new Error(`[GoRunner] runner ${runnerId} at capacity for job=${jobId}`);
    }

    node.inFlight += 1;
    this.logger.debug(
      `[GoRunner] dispatch runId=${runId} jobId=${jobId} runner=${runnerId} pool=${pool} span=${traceSpanId}`,
    );

    // TODO: S9 后续迭代：通过 gRPC 向真实 Runner 发送 JobAssign
    // 当前模拟：异步完成后回传结果
    await this.simulateRunnerExecution(intent, runnerId);
  }

  async cancelJob(params: { runId: string; jobId: string; reason: string }): Promise<void> {
    this.logger.log(`[GoRunner] cancelJob runId=${params.runId} jobId=${params.jobId} reason=${params.reason}`);
    // TODO: 向 Runner 发送 JobCancel gRPC 消息
  }

  async healthy(): Promise<boolean> {
    const healthyCount = [...this.runners.values()].filter(
      (r) => Date.now() - r.lastHeartbeat < parseInt(this.config.heartbeatTimeoutMs, 10),
    ).length;
    return healthyCount > 0;
  }

  /** 测试用：获取 Runner 节点快照 */
  getRunnersSnapshot(): RunnerNode[] {
    return [...this.runners.values()];
  }

  // ── 私有方法 ──────────────────────────────────────────────────────

  private selectRunner(pool: string): string | null {
    const poolRunners = this.poolIndex.get(pool);
    if (!poolRunners || poolRunners.size === 0) return null;

    let best: string | null = null;
    let bestLoad = Infinity;
    for (const rid of poolRunners) {
      const node = this.runners.get(rid);
      if (!node) continue;
      if (node.inFlight < bestLoad) {
        best = rid;
        bestLoad = node.inFlight;
      }
    }
    return best;
  }

  /**
   * simulateRunnerExecution —— 模拟 Runner 执行并回传结果
   *
   * 生产实现：Runner 通过 gRPC stream 回传 JobResult，
   * 此处改为直接 emit（模拟 Runner 已完成执行）。
   */
  private async simulateRunnerExecution(intent: DispatcherIntent, runnerId: string): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const node = this.runners.get(runnerId);
    if (node) node.inFlight -= 1;

    const result = {
      runId: intent.runId,
      jobId: intent.jobId,
      attempt: intent.attempt,
      exitCode: 0,
      stdout: `[GoRunner] job=${intent.jobId} on ${runnerId} completed`,
      stderr: '',
      durationMs: 10,
      success: true,
      traceSpanId: intent.traceSpanId,
    };
    this.logger.debug(
      `[GoRunner] result runId=${result.runId} jobId=${result.jobId} exit=${result.exitCode} span=${result.traceSpanId}`,
    );
    void result;
  }
}
