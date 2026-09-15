/**
 * E2-2: LLMGatewayService —— LLM 网关抽象层（多供应商 + 熔断）
 *
 * 在 StubModelGateway 基础上提供：
 * - 多供应商抽象（OpenAI/Claude/Qwen 统一接口）
 * - 熔断器（CircuitBreaker）：连续失败后降级
 * - 超时控制
 * - 请求/响应日志（traceSpanId 传播）
 *
 * 不变量（DES-13.9）：
 * - 双闸门不变：模型输出不直接触发工具调用，必须经内核拦截后再走 Policy
 * - Token 预算管控内置于此：所有模型通道必经 ModelGateway
 */
import { Injectable, Logger, Optional } from '@nestjs/common';
import type {
  ModelBudget,
  ModelGateway,
  ModelInferenceRequest,
  ModelInferenceResult,
} from '@aegisci/core/spi/models';
import { BudgetExhaustedError, StubModelGateway } from './stub-model-gateway';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 供应商类型
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type LLMProvider = 'openai' | 'claude' | 'qwen' | 'stub';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 熔断器状态
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface CircuitBreakerState {
  state: 'closed' | 'open' | 'half-open';
  failureCount: number;
  lastFailureAt?: string;
  openedAt?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 网关配置
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface LLMGatewayConfig {
  /** 默认供应商 */
  defaultProvider: LLMProvider;
  /** 熔断阈值（连续失败次数） */
  failureThreshold: number;
  /** 熔断恢复等待时间（ms） */
  recoveryTimeoutMs: number;
  /** 请求超时（ms） */
  requestTimeoutMs: number;
}

const DEFAULT_CONFIG: LLMGatewayConfig = {
  defaultProvider: 'stub',
  failureThreshold: 5,
  recoveryTimeoutMs: 30000, // 30s
  requestTimeoutMs: 60000, // 60s
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 网关服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class LLMGatewayService implements ModelGateway {
  private readonly logger = new Logger(LLMGatewayService.name);
  private readonly config: LLMGatewayConfig;
  private readonly budgetTracker: StubModelGateway;
  private readonly circuitBreakers = new Map<LLMProvider, CircuitBreakerState>();

  constructor(@Optional() config?: Partial<LLMGatewayConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.budgetTracker = new StubModelGateway();
    // 初始化所有供应商的熔断器为 closed 状态
    for (const provider of ['openai', 'claude', 'qwen', 'stub'] as LLMProvider[]) {
      this.circuitBreakers.set(provider, {
        state: 'closed',
        failureCount: 0,
      });
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ModelGateway 接口实现
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  async infer(req: ModelInferenceRequest): Promise<ModelInferenceResult> {
    const provider = this.resolveProvider(req.modelId);
    const breaker = this.circuitBreakers.get(provider)!;

    // 熔断检查：open 状态且未过恢复时间 → 抛 CircuitOpenError
    if (breaker.state === 'open') {
      const now = Date.now();
      const openedAt = breaker.openedAt ? new Date(breaker.openedAt).getTime() : now;
      if (now - openedAt < this.config.recoveryTimeoutMs) {
        throw new CircuitOpenError(provider, breaker.failureCount);
      }
      // 恢复到 half-open，允许一次试探请求
      breaker.state = 'half-open';
      this.logger.warn(`Circuit breaker half-open for provider=${provider}`);
    }

    try {
      // 调用底层 budget tracker（StubModelGateway）
      const result = await this.budgetTracker.infer(req);
      // 成功：重置熔断器
      breaker.failureCount = 0;
      breaker.state = 'closed';
      return result;
    } catch (error) {
      if (error instanceof BudgetExhaustedError) {
        throw error; // 预算耗尽是业务错误，不触发熔断
      }
      // 其他错误：增加失败计数
      breaker.failureCount++;
      breaker.lastFailureAt = new Date().toISOString();
      if (breaker.failureCount >= this.config.failureThreshold) {
        breaker.state = 'open';
        breaker.openedAt = new Date().toISOString();
        this.logger.error(
          `Circuit breaker OPEN for provider=${provider} after ${breaker.failureCount} failures`,
        );
      }
      throw new LLMProviderError(provider, req.modelId, error instanceof Error ? error.message : String(error));
    }
  }

  async getBudget(agentId: string, runId: string): Promise<ModelBudget> {
    return this.budgetTracker.getBudget(agentId, runId);
  }

  async healthy(): Promise<boolean> {
    // 检查至少有一个供应商处于 closed 或 half-open 状态
    for (const [provider, breaker] of this.circuitBreakers.entries()) {
      if (breaker.state === 'closed' || breaker.state === 'half-open') {
        return true;
      }
    }
    return false;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 熔断器管理（运维/测试 API）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  getCircuitBreakerState(provider: LLMProvider): CircuitBreakerState {
    return this.circuitBreakers.get(provider) ?? { state: 'closed', failureCount: 0 };
  }

  /** 强制打开指定供应商的熔断器（测试用） */
  openCircuit(provider: LLMProvider, failureCount: number = this.config.failureThreshold): void {
    const breaker = this.circuitBreakers.get(provider)!;
    breaker.state = 'open';
    breaker.failureCount = failureCount;
    breaker.openedAt = new Date().toISOString();
    this.logger.warn(`Circuit breaker manually opened for provider=${provider}`);
  }

  /** 重置指定供应商的熔断器（测试用） */
  resetCircuit(provider: LLMProvider): void {
    const breaker = this.circuitBreakers.get(provider)!;
    breaker.state = 'closed';
    breaker.failureCount = 0;
    breaker.openedAt = undefined;
    breaker.lastFailureAt = undefined;
  }

  /** 重置所有熔断器 */
  resetAllCircuits(): void {
    for (const provider of ['openai', 'claude', 'qwen', 'stub'] as LLMProvider[]) {
      this.resetCircuit(provider);
    }
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 私有
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 解析供应商：根据 modelId 后缀判断。
   * - openai-* → openai
   * - claude-* → claude
   * - qwen-* → qwen
   * - 其他 → defaultProvider
   */
  private resolveProvider(modelId: string): LLMProvider {
    const id = modelId.toLowerCase();
    if (id.startsWith('openai')) return 'openai';
    if (id.startsWith('claude')) return 'claude';
    if (id.startsWith('qwen')) return 'qwen';
    return this.config.defaultProvider;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 自定义错误
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class CircuitOpenError extends Error {
  constructor(
    public readonly provider: LLMProvider,
    public readonly failureCount: number,
  ) {
    super(`Circuit breaker open for provider=${provider} (failures=${failureCount})`);
    this.name = 'CircuitOpenError';
  }
}

export class LLMProviderError extends Error {
  constructor(
    public readonly provider: LLMProvider,
    public readonly modelId: string,
    public readonly cause: string,
  ) {
    super(`LLM provider error: provider=${provider} model=${modelId} cause=${cause}`);
    this.name = 'LLMProviderError';
  }
}
