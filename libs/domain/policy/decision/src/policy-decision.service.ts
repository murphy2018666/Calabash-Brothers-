import { createHash, randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  AuthorizeRequest,
  AuthorizeResult,
  PolicyEvidence,
} from '@aegisci/shared/types';
import { SPI_TOKENS, type PolicyEngineSPI } from '@aegisci/core/spi';

/**
 * Policy Decision 子域 —— 裁决同步入口 + Redis 判定缓存（DES-5.0 热路径）。
 *
 * 域内交互约束：
 * - Decision 是唯一对外同步入口：OR/SR/ACI 仅同步调用 authorize；Approval/Credential 不对外提供同步接口。
 * - 缓存键含 policyVersion，引擎版本变更即整批失效。
 * - 默认拒绝：无匹配规则或引擎异常 → DENY（fail-closed，证据链不中断）。
 * - 影响面：PolicyEngine SPI 仅替换本子域内求值器实现（DES-13），Approval/Credential 不随引擎切换。
 *
 * 持久化：PG policy_decision_*（裁决留痕）+ Redis 判定缓存；禁止跨子域 JOIN。
 */

/** Redis 判定缓存抽象 —— 由基础设施层注入实现，避免本子域直接依赖具体 Redis 客户端。 */
export const POLICY_DECISION_CACHE = Symbol('POLICY_DECISION_CACHE');

export interface PolicyDecisionCache {
  get(key: string): Promise<AuthorizeResult | null>;
  set(key: string, value: AuthorizeResult, ttlSeconds: number): Promise<void>;
}

/** 缓存 TTL（秒）；G2+ 旁路缓存命中目标 <1ms。 */
const CACHE_TTL_SECONDS = 300;

@Injectable()
export class PolicyDecisionService {
  private readonly logger = new Logger(PolicyDecisionService.name);

  constructor(
    @Inject(SPI_TOKENS.POLICY_ENGINE) private readonly engine: PolicyEngineSPI,
    @Inject(POLICY_DECISION_CACHE) private readonly cache: PolicyDecisionCache,
  ) {}

  /**
   * 策略裁决 —— 同步热路径，P95 < 5ms。
   * 命中缓存直接返回（cacheHit=true）；未命中走引擎求值，写回缓存。
   */
  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const policyVersion = this.engine.getPolicyVersion();
    const cacheKey = this.cacheKey(policyVersion, req);

    const cached = await this.cache.get(cacheKey);
    if (cached) {
      return { ...cached, cacheHit: true };
    }

    let result: AuthorizeResult;
    try {
      result = await this.engine.authorize(req);
    } catch (err) {
      // fail-closed：引擎异常 → 默认拒绝，证据链不中断。
      this.logger.error(`policy engine failure, denying: ${(err as Error).message}`);
      result = this.deny(req, policyVersion, 'POLICY_ENGINE_ERROR');
    }

    // 默认拒绝语义不变：引擎未给出决策时兜底 DENY。
    if (!result || !result.decision) {
      result = this.deny(req, policyVersion, 'NO_DECISION');
    }

    await this.cache.set(cacheKey, result, CACHE_TTL_SECONDS);
    return { ...result, cacheHit: false };
  }

  /** 策略 simulate 透传（FR-M3-08）。 */
  simulate(req: AuthorizeRequest): Promise<AuthorizeResult> {
    return this.engine.simulate(req);
  }

  /** 当前策略版本号（缓存键组成部分）。 */
  getPolicyVersion(): string {
    return this.engine.getPolicyVersion();
  }

  private cacheKey(policyVersion: string, req: AuthorizeRequest): string {
    const ctxHash = createHash('sha1')
      .update(JSON.stringify(req.context ?? {}))
      .digest('hex')
      .slice(0, 16);
    return `poldec:${policyVersion}:${req.principal.id}:${req.action}:${req.resource}:${ctxHash}`;
  }

  private deny(req: AuthorizeRequest, policyVersion: string, reason: string): AuthorizeResult {
    const evidence: PolicyEvidence = {
      evidenceId: randomUUID(),
      policyVersion,
      decision: 'DENY',
      reason,
      rules: [],
      timestamp: new Date().toISOString(),
    };
    return { decision: 'DENY', evidence, cacheHit: false };
  }
}
