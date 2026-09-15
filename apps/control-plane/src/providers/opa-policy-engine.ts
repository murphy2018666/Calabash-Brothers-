/**
 * L5-2: OpaPolicyEngine —— OPA（Open Policy Agent）策略引擎（V1.5）
 *
 * 对应 WBS: L5 其他 SPI 可插拔实现（1.9.5）
 * 对应风险: R34 OPA 与 EmbeddedPolicyEngine 裁决不一致
 *
 * 不变量（DES-13.9 / FR-M7-06）：
 * - 默认拒绝语义不变：无匹配规则 = DENY（fail-closed）
 * - DENY/HALLOW 输出契约不变：必须返回 evidenceId
 * - simulate 与 authorize 语义一致（FR-M3-08）
 */

import { randomUUID } from 'crypto';
import type { PolicyEngineSPI, PolicyRule } from '@aegisci/core/spi/policy';
import type { AuthorizeRequest, AuthorizeResult, PolicyEvidence } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** OPA 请求体（Rego 输入） */
export interface OpaInput {
  action: string;
  resource: string;
  subject: string;
  environment: string;
  attributes?: Record<string, unknown>;
}

/** OPA 响应体 */
export interface OpaResponse {
  result: {
    decisions: Array<{
      id: string;
      result: boolean;
      decision_id: string;
    }>;
  };
}

/** OPA Bridge 配置 */
export interface OpaBridgeConfig {
  /** OPA HTTP API 地址，如 http://opa.aegisci.local:8181 */
  url: string;
  /** OPA 命名空间 */
  namespace: string;
  /** 超时（ms），默认 5000 */
  timeoutMs?: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 实现
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * OpaPolicyEngine —— OPA 策略引擎实现。
 *
 * DCR-17-02：使用 OPA HTTP API（/v1/data/<path> + /v1/policies）
 *
 * 实现档位（DES-13 实现档位）：
 * - V1.5：HTTP API 对接（stub，便于单元测试）
 * - V2.0：gRPC 接口适配器 + 实时策略热更新
 */
export class OpaPolicyEngine implements PolicyEngineSPI {
  private readonly config: OpaBridgeConfig;
  private policyVersion = 'v0';
  /** 本地规则缓存（用于 shadow mode 对比） */
  private readonly localRules: PolicyRule[] = [];

  constructor(config: OpaBridgeConfig) {
    this.config = config;
  }

  /**
   * authorize —— OPA 策略裁决。
   *
   * 安全不变量（DES-13.9）：
   * - 默认拒绝：OPA 不可达时返回 DENY
   * - evidenceId 始终有值
   */
  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    try {
      const opaDecision = await this.queryOpa(req);
      return this.mapOpaDecision(req, opaDecision);
    } catch (err) {
      // 安全降级：OPA 不可用时返回 DENY
      console.warn(`[OpaPolicyEngine] OPA 查询失败，降级为 DENY: ${err}`);
      return this.deny(req, 'OPA_UNAVAILABLE');
    }
  }

  getPolicyVersion(): string {
    return this.policyVersion;
  }

  /**
   * simulate —— 策略模拟（与 authorize 语义一致，FR-M3-08）。
   */
  async simulate(req: AuthorizeRequest): Promise<AuthorizeResult> {
    return this.authorize(req);
  }

  async healthy(): Promise<boolean> {
    try {
      const resp = await this.fetch('/v1/admin/data/health', { method: 'GET' });
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * loadRules —— 将本地规则同步到 OPA（stub）。
   * 真实实现：将 Rego 策略上传到 OPA admin API。
   */
  loadRules(rules: PolicyRule[]): void {
    this.localRules = [...rules];
    this.policyVersion = `opa-v${Date.now()}`;
    // Stub: 上传 Rego 策略到 OPA
    console.log(`[OpaPolicyEngine] loadRules ${rules.length} rules, version=${this.policyVersion}`);
  }

  ruleCount(): number {
    return this.localRules.length;
  }

  // ── 私有方法 ──

  /** 查询 OPA（stub）。真实实现需 HTTP POST。 */
  private async queryOpa(req: AuthorizeRequest): Promise<OpaResponse> {
    // Stub: 基于本地规则做判定（模拟 OPA Rego 求值）
    // 无规则时返回 DENY（fail-closed，与 EmbeddedPolicyEngine DEFAULT_DENY 一致）
    const decisionId = randomUUID();
    if (this.localRules.length === 0) {
      return {
        result: {
          decisions: [
            {
              id: decisionId,
              result: false,
              decision_id: 'default-deny',
            },
          ],
        },
      };
    }
    const matched = this.localRules.find((r) => {
      if (r.action !== '*' && r.action !== req.action) return false;
      if (r.resource === '*') return true;
      if (r.resource.endsWith('/*')) {
        return req.resource.startsWith(r.resource.slice(0, -1));
      }
      return r.resource === req.resource;
    });
    const allowed = matched?.effect === 'allow';
    return {
      result: {
        decisions: [
          {
            id: decisionId,
            result: allowed,
            decision_id: matched?.id ?? 'default-deny',
          },
        ],
      },
    };
  }

  /** 将 OPA 决策映射为 AuthorizeResult。 */
  private mapOpaDecision(req: AuthorizeRequest, opaResp: OpaResponse): AuthorizeResult {
    const decision = opaResp.result.decisions[0];
    const evidence: PolicyEvidence = {
      evidenceId: randomUUID(),
      policyVersion: this.policyVersion,
      decision: decision?.result ? 'ALLOW' : 'DENY',
      reason: decision?.result ? `OPA_ALLOW:${decision.decision_id}` : `OPA_DENY:${decision.decision_id}`,
      rules: decision ? [decision.decision_id] : [],
      timestamp: new Date().toISOString(),
    };
    return {
      decision: evidence.decision as 'ALLOW' | 'DENY',
      evidence,
      cacheHit: false,
    };
  }

  private deny(req: AuthorizeRequest, reason: string): AuthorizeResult {
    void req;
    const evidence: PolicyEvidence = {
      evidenceId: randomUUID(),
      policyVersion: this.policyVersion,
      decision: 'DENY',
      reason,
      rules: [],
      timestamp: new Date().toISOString(),
    };
    return { decision: 'DENY', evidence, cacheHit: false };
  }

  /** 通用 fetch helper（stub，真实实现用 undici/axios）。 */
  private async fetch(path: string, init?: RequestInit): Promise<{ status: number }> {
    void init;
    // Stub: 始终返回 200（OPA 健康）
    return { status: 200 };
  }
}
