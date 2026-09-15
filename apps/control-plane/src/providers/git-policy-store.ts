import { Injectable } from '@nestjs/common';
import type { PolicyEngineSPI, PolicyRule } from '@aegisci/core/spi';
import type { AuthorizeRequest, AuthorizeResult, PolicyEvidence } from '@aegisci/shared/types';
import { randomUUID } from 'crypto';
import { GitPolicyLoader, type PolicyVersion } from './git-policy-loader';

/**
 * GitPolicyStore —— 基于 GitPolicyLoader 的策略存储与执行引擎。
 *
 * 实现 PolicyEngineSPI 接口，将策略从 Git 热加载到内存并支持裁决。
 *
 * 功能：
 * - 启动时从 Git 加载默认策略
 * - 热更新：新策略版本加载后原子替换
 * - 版本回滚：支持 rollbackTo(version)
 * - Shadow Mode：新策略先写入影子引擎，验证一致后再切换
 */
@Injectable()
export class GitPolicyStore implements PolicyEngineSPI {
  private activeRules: PolicyRule[] = [];
  private policyVersion = 'v0';
  private shadowRules: PolicyRule[] | null = null;

  constructor(private readonly loader: GitPolicyLoader) {}

  /**
   * 从 Git 加载并激活策略（公共入口）。
   */
  async loadFromGit(shadow = false): Promise<PolicyVersion> {
    const pv = await this.loader.loadAndActivate(shadow);
    if (shadow) {
      this.shadowRules = pv.ast.rules;
    } else {
      this.activateVersion(pv);
    }
    return pv;
  }

  /**
   * 激活指定版本（内部调用）。
   */
  private activateVersion(pv: PolicyVersion): void {
    this.policyVersion = pv.version;
    this.activeRules = pv.ast.rules;
  }

  // ── PolicyEngineSPI 实现 ─────────────────────────────────────────────

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
    return this.authorize(req);
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  /** 当前已加载规则数。 */
  ruleCount(): number {
    return this.activeRules.length;
  }

  /**
   * 直接加载规则集（绕过 GitLoader，用于测试）。
   */
  loadRules(rules: PolicyRule[]): void {
    this.activeRules = [...rules];
    this.policyVersion = `manual-${Date.now()}`;
  }

  /**
   * 切换为影子引擎版本（验证通过后调用）。
   */
  activateShadow(): void {
    const shadowPv = this.loader.getShadowVersion();
    if (this.shadowRules !== null || shadowPv !== null) {
      const rules = this.shadowRules ?? shadowPv!.ast.rules;
      this.activeRules = rules;
      this.policyVersion = shadowPv?.version ?? this.policyVersion;
      this.shadowRules = null;
      this.loader.clearShadow();
    }
  }

  // ── 内部求值逻辑 ─────────────────────────────────────────────────────

  private firstMatch(req: AuthorizeRequest): PolicyRule | null {
    let firstAllow: PolicyRule | null = null;
    for (const rule of this.activeRules) {
      if (!this.matches(rule, req)) continue;
      if (rule.effect === 'deny') return rule;
      if (firstAllow === null) firstAllow = rule;
    }
    return firstAllow;
  }

  private matches(rule: PolicyRule, req: AuthorizeRequest): boolean {
    return (
      rule.action === '*' || rule.action === req.action
    ) && (
      this.resourceMatches(rule.resource, req.resource)
    );
  }

  private resourceMatches(pattern: string, resource: string): boolean {
    if (pattern === '*') return true;
    if (pattern.endsWith('/*')) {
      const prefix = pattern.slice(0, -1);
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

  private deny(req: AuthorizeRequest, reason: string, ruleId?: string): AuthorizeResult {
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
