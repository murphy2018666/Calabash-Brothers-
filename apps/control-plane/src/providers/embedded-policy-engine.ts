import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import type { PolicyEngineSPI, PolicyRule } from '@aegisci/core/spi/policy';
import type {
  AuthorizeRequest,
  AuthorizeResult,
  PolicyEvidence,
} from '@aegisci/shared/types';

/**
 * EmbeddedPolicyEngine —— 内嵌策略求值引擎（V1.0 默认，SPI 实现）。
 *
 * 对应设计：DES-13 实现档位 EmbeddedPolicyEngine / DES-5.0 热路径。
 * 不变量（DES-13.9 安全交叉保证）：
 * - 默认拒绝语义不变：无匹配规则 = DENY（fail-closed，证据链不中断）。
 * - DENY/HALLOW 输出契约不变：必须返回 evidenceId。
 * - 策略版本化：getPolicyVersion() 为缓存键组成部分。
 *
 * L2-2 DSL 深化（Cedar 风格基础 DSL）：
 * - loadRules(rules) 覆盖式加载规则集（reloadable）
 * - action 通配 '*' 匹配任意 action
 * - resource 前缀匹配：'repo/*' 匹配 'repo/x' / 'repo/any/here'
 * - first-match-wins：同 effect 内取首条匹配规则
 * - deny-wins-on-conflict：deny 规则优先于 allow 规则（fail-closed）
 * - 无匹配规则 = DENY（DEFAULT_DENY 不变量）
 */
@Injectable()
export class EmbeddedPolicyEngine implements PolicyEngineSPI {
  private policyVersion = 'v0';
  private rules: PolicyRule[] = [];

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const matched = this.firstMatch(req);
    if (!matched) {
      return this.deny(req, 'DEFAULT_DENY');
    }
    if (matched.effect === 'allow') {
      return this.allow(req, matched.id);
    }
    return this.deny(req, `DENY:${matched.id}`, matched.id);
  }

  getPolicyVersion(): string {
    return this.policyVersion;
  }

  async simulate(req: AuthorizeRequest): Promise<AuthorizeResult> {
    // L2-2：simulate 复用 authorize 求值路径，确保模拟语义与裁决一致（FR-M3-08）。
    return this.authorize(req);
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  /** 更新策略版本号（缓存整批失效键）。 */
  setPolicyVersion(version: string): void {
    this.policyVersion = version;
  }

  /**
   * 覆盖式加载规则集（reloadable）。
   * 调用后旧规则全部失效，新规则按数组顺序参与 first-match-wins 求值。
   */
  loadRules(rules: PolicyRule[]): void {
    this.rules = [...rules];
  }

  /** 当前已加载规则数（运维/测试用，非 SPI 契约）。 */
  ruleCount(): number {
    return this.rules.length;
  }

  /**
   * 求值首条匹配规则（deny-precedence + first-match-wins）。
   *
   * 实现策略：
   * 1. 先扫描第一条匹配的 deny 规则（deny-wins-on-conflict）
   * 2. 若无 deny 匹配，再扫描第一条匹配的 allow 规则
   * 3. 都无匹配返回 null（authorize 视为 DEFAULT_DENY）
   *
   * 同 effect 内多条规则命中时取数组顺序中第一条（first-match-wins）。
   */
  private firstMatch(req: AuthorizeRequest): PolicyRule | null {
    let firstAllow: PolicyRule | null = null;
    for (const rule of this.rules) {
      if (!this.matches(rule, req)) {
        continue;
      }
      // deny 优先：发现首条 deny 立即返回（fail-closed）。
      if (rule.effect === 'deny') {
        return rule;
      }
      // 记录首条 allow，待扫描完所有规则后无 deny 命中再返回。
      if (firstAllow === null) {
        firstAllow = rule;
      }
    }
    return firstAllow;
  }

  /** 单条规则匹配（action 通配 + resource 前缀/通配）。 */
  private matches(rule: PolicyRule, req: AuthorizeRequest): boolean {
    return (
      this.actionMatches(rule.action, req.action) &&
      this.resourceMatches(rule.resource, req.resource)
    );
  }

  private actionMatches(pattern: string, action: string): boolean {
    return pattern === '*' || pattern === action;
  }

  private resourceMatches(pattern: string, resource: string): boolean {
    if (pattern === '*') {
      return true;
    }
    // 'repo/*' → 前缀 'repo/' 匹配 'repo/x' / 'repo/a/b'（不支持中间通配）
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1); // 保留尾斜杠：'repo/*' → 'repo/'
      return resource.startsWith(prefix);
    }
    return pattern === resource;
  }

  private allow(req: AuthorizeRequest, ruleId: string): AuthorizeResult {
    void req;
    const evidence: PolicyEvidence = {
      evidenceId: randomUUID(),
      policyVersion: this.policyVersion,
      decision: 'ALLOW',
      reason: `ALLOW:${ruleId}`,
      rules: [ruleId],
      timestamp: new Date().toISOString(),
    };
    return { decision: 'ALLOW', evidence, cacheHit: false };
  }

  private deny(
    req: AuthorizeRequest,
    reason: string,
    ruleId?: string,
  ): AuthorizeResult {
    void req;
    const evidence: PolicyEvidence = {
      evidenceId: randomUUID(),
      policyVersion: this.policyVersion,
      decision: 'DENY',
      reason,
      rules: ruleId ? [ruleId] : [],
      timestamp: new Date().toISOString(),
    };
    return { decision: 'DENY', evidence, cacheHit: false };
  }
}
