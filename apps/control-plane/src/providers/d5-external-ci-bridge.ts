/**
 * 外部CI桥接适配器 (D5-3)
 *
 * 设计目标：桥接外部 CI 系统（Jenkins / GitHub Actions），
 * 允许 AegisCI 将流水线步骤委托给已有 CI 基础设施，
 * 同时保持统一审计与追踪。
 *
 * 对应文档：DES-1 执行后端选型（③ 外部CI桥接）
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ConnectionGatewayPort } from '@aegisci/domain/pipeline';

/**
 * CiProvider —— 外部 CI 系统抽象
 */
export type CiProvider = 'jenkins' | 'github-actions' | 'gitlab-ci';

/**
 * BridgeSpec —— 桥接配置
 */
export interface BridgeSpec {
  provider: CiProvider;
  baseUrl: string;
  /** 凭证引用（Vault secret path 或环境变量名） */
  credentialRef: string;
  /** 目标 pipeline/job 名称 */
  targetJob: string;
  /** 可选：自定义参数映射 */
  paramMapping?: Record<string, string>;
}

/**
 * CiJobResult —— 外部 CI 执行结果
 */
export interface CiJobResult {
  runId: string;
  jobId: string;
  attempt: number;
  provider: CiProvider;
  externalJobUrl: string;
  externalJobId: string;
  exitCode: number;
  durationMs: number;
  success: boolean;
  traceSpanId: string;
}

@Injectable()
export class ExternalCIBridge implements ConnectionGatewayPort {
  private readonly logger = new Logger(ExternalCIBridge.name);
  /** bridgeName → BridgeSpec */
  private readonly bridges = new Map<string, BridgeSpec>();
  private readonly config: Record<string, string>;

  constructor(private readonly configService: ConfigService) {
    this.config = {
      defaultTimeoutMs: this.configService.get('AEGISCI_CI_BRIDGE_TIMEOUT_MS', '600000'),
    };
  }

  /**
   * registerBridge —— 注册一个外部 CI 桥接配置
   */
  registerBridge(name: string, spec: BridgeSpec): void {
    this.bridges.set(name, spec);
    this.logger.log(`[CiBridge] registerBridge name=${name} provider=${spec.provider} job=${spec.targetJob}`);
  }

  async dispatchJob(params: {
    runId: string;
    jobId: string;
    attempt: number;
    pool: string;
    spec: Record<string, unknown>;
  }): Promise<void> {
    const { runId, jobId, attempt, spec } = params;

    // 从 spec.bridgeName 选择桥接配置
    const bridgeName = String(spec.bridgeName ?? 'default');
    const bridgeSpec = this.bridges.get(bridgeName);
    if (!bridgeSpec) {
      throw new Error(`[CiBridge] no bridge config for name=${bridgeName}, registered: ${[...this.bridges.keys()].join(', ')}`);
    }

    const traceSpanId = `cibridge-${jobId}-${Date.now()}`;
    this.logger.debug(
      `[CiBridge] dispatch runId=${runId} jobId=${jobId} bridge=${bridgeName} provider=${bridgeSpec.provider} span=${traceSpanId}`,
    );

    // TODO: S9 后续迭代：集成真实 Jenkins/GHA HTTP API
    // - Jenkins: POST /job/{name}/buildWithParameters
    // - GHA:   CREATE workflow_dispatch via REST API
    await this.simulateCiExecution({
      runId,
      jobId,
      attempt,
      provider: bridgeSpec.provider,
      traceSpanId,
      baseUrl: bridgeSpec.baseUrl,
      targetJob: bridgeSpec.targetJob,
    });
  }

  async cancelJob(params: { runId: string; jobId: string; reason: string }): Promise<void> {
    this.logger.log(`[CiBridge] cancelJob runId=${params.runId} jobId=${params.jobId} reason=${params.reason}`);
    // TODO: 调用外部 CI 取消 API
  }

  async healthy(): Promise<boolean> {
    return this.bridges.size > 0;
  }

  /** 测试用：获取注册桥接 */
  getBridges(): Map<string, BridgeSpec> {
    return this.bridges;
  }

  // ── 私有方法 ──────────────────────────────────────────────────────

  private async simulateCiExecution(params: {
    runId: string;
    jobId: string;
    attempt: number;
    provider: CiProvider;
    traceSpanId: string;
    baseUrl: string;
    targetJob: string;
  }): Promise<void> {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));

    const result: CiJobResult = {
      ...params,
      externalJobUrl: `${params.baseUrl}/job/${params.targetJob}/1`,
      externalJobId: `ext-${params.jobId}`,
      exitCode: 0,
      durationMs: 10,
      success: true,
    };
    this.logger.debug(
      `[CiBridge] result runId=${result.runId} jobId=${result.jobId} provider=${result.provider} url=${result.externalJobUrl} span=${result.traceSpanId}`,
    );
    void result;
  }
}
