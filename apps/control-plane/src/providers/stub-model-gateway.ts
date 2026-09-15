import { Injectable } from '@nestjs/common';
import type {
  ModelBudget,
  ModelGateway,
  ModelInferenceRequest,
  ModelInferenceResult,
} from '@aegisci/core/spi/models';

/**
 * StubModelGateway —— 开发用桩模型网关（V1.0 默认，SPI 实现）。
 *
 * 不变量（DES-13.9 安全交叉保证）：
 * - 双闸门不变：模型输出不直接触发工具调用，必须经内核拦截后再走 Policy。
 * - Token 预算管控内置于此：所有模型通道必经 ModelGateway。
 *
 * L2-5 深化（DES-8 三级降级策略）：
 * - 预算追踪：每次 infer 消耗 inputTokens + outputTokens，写入 budget Map
 * - Tier 1（剩余 < 50% totalBudget）：切换轻量模型（modelId 加 '-lite' 后缀，degraded=true）
 * - Tier 2（剩余 < 20% totalBudget）：返回缓存响应（cached=true，不消耗 token）
 * - Tier 3（剩余 = 0）：抛 BudgetExhaustedError 拒绝推理
 * - setBudget / resetBudget：运维与测试用，可重置预算状态
 */
const DEFAULT_BUDGET = 8000;
const TIER1_THRESHOLD = 0.5; // 剩余 < 50% totalBudget 触发 Tier 1
const TIER2_THRESHOLD = 0.2; // 剩余 < 20% totalBudget 触发 Tier 2

/**
 * 预算耗尽错误：Tier 3 拒绝推理时抛出（fail-closed）。
 * 内核可捕获并决定是否降级到纯本地模式或终止 run。
 */
export class BudgetExhaustedError extends Error {
  constructor(
    public readonly agentId: string,
    public readonly runId: string,
    public readonly remaining: number,
    public readonly requested: number,
  ) {
    super(
      `model budget exhausted: agent=${agentId} run=${runId} remaining=${remaining} requested=${requested}`,
    );
    this.name = 'BudgetExhaustedError';
  }
}

@Injectable()
export class StubModelGateway implements ModelGateway {
  /** budget key = `${agentId}|${runId}`；引用语义，外部 mutate 即生效。 */
  private readonly budgets = new Map<string, ModelBudget>();

  async infer(req: ModelInferenceRequest): Promise<ModelInferenceResult> {
    const budget = this.getOrInitBudget(req.agentId, req.runId);
    const remaining = budget.remaining;

    // Tier 3：预算耗尽，拒绝推理（fail-closed）。
    if (remaining <= 0) {
      throw new BudgetExhaustedError(
        req.agentId,
        req.runId,
        0,
        req.maxTokens,
      );
    }

    const total = budget.totalBudget;

    // Tier 2：剩余严重不足，返回缓存响应（不消耗 token）。
    if (remaining < total * TIER2_THRESHOLD) {
      return this.cachedResponse(req);
    }

    // StubModelGateway 默认视为降级（stub/模拟），always degraded=true。
    // 仅当预算降至 Tier 1 (<50%) 时切换轻量模型 ID。
    let modelId = req.modelId;
    const degraded = true;
    if (remaining < total * TIER1_THRESHOLD) {
      modelId = `${req.modelId}-lite`;
    }

    const inputTokens = Math.min(req.maxTokens, 64);
    const outputTokens = this.computeOutputTokens(req, modelId);
    const consumed = inputTokens + outputTokens;

    // 若单次推理就超出剩余预算，则升级到 Tier 2 缓存响应（避免负数）。
    if (consumed > remaining) {
      return this.cachedResponse(req);
    }

    budget.consumed += consumed;
    budget.remaining = Math.max(0, budget.remaining - consumed);

    const content = `[stub] inference for agent ${req.agentId} on run ${req.runId}`;
    return {
      content,
      inputTokens,
      outputTokens,
      modelId,
      degraded,
      traceSpanId: `span_${req.runId}`,
    };
  }

  async getBudget(agentId: string, runId: string): Promise<ModelBudget> {
    return this.getOrInitBudget(agentId, runId);
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  /**
   * 设置/重置某 (agentId, runId) 的预算状态（运维/测试用，Impl-level API）。
   * 默认 consumed=0；可传入已消耗量以模拟降级场景。
   */
  async setBudget(
    agentId: string,
    runId: string,
    totalBudget: number,
    consumed = 0,
  ): Promise<void> {
    const key = `${agentId}|${runId}`;
    const remaining = Math.max(0, totalBudget - consumed);
    this.budgets.set(key, {
      agentId,
      runId,
      totalBudget,
      consumed,
      remaining,
    });
  }

  /**
   * 清除某 (agentId, runId) 的预算记录（熔断恢复 / 测试隔离用，Impl-level API）。
   * 下次 getBudget/infer 会以默认预算重新初始化。
   */
  async resetBudget(agentId: string, runId: string): Promise<void> {
    const key = `${agentId}|${runId}`;
    this.budgets.delete(key);
  }

  private getOrInitBudget(agentId: string, runId: string): ModelBudget {
    const key = `${agentId}|${runId}`;
    let budget = this.budgets.get(key);
    if (!budget) {
      budget = {
        agentId,
        runId,
        totalBudget: DEFAULT_BUDGET,
        consumed: 0,
        remaining: DEFAULT_BUDGET,
      };
      this.budgets.set(key, budget);
    }
    return budget;
  }

  /** Tier 2 缓存响应：不消耗 token，返回 cached 标记。 */
  private cachedResponse(req: ModelInferenceRequest): ModelInferenceResult {
    return {
      content: `[stub:cached] cached response for agent ${req.agentId} on run ${req.runId}`,
      inputTokens: 0,
      outputTokens: 0,
      modelId: req.modelId,
      degraded: true,
      cached: true,
      traceSpanId: `span_${req.runId}_cached`,
    };
  }

  /** 计算预期 output token 数：轻量模型返回更短输出。 */
  private computeOutputTokens(
    req: ModelInferenceRequest,
    modelId: string,
  ): number {
    const base = `[stub] inference for agent ${req.agentId} on run ${req.runId}`
      .length;
    return modelId.endsWith('-lite') ? Math.floor(base / 2) : base;
  }
}
