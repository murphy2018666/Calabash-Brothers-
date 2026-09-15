/**
 * L6-3 PolicyEngine Shadow Mode 双引擎并行验证框架
 *
 * 验证 EmbeddedPolicyEngine 与 OPA 占位引擎的裁决一致性。
 * 规则：
 * - Shadow Mode 下两引擎并行执行，决策结果必须完全一致（一致率 100%）
 * - 不一致即告警，禁止切换到新引擎
 * - Shadow 引擎不生效，仅用于对比验证（DES-13.9 安全交叉保证）
 */

import { Test } from '@nestjs/testing';
import { SpiDefaultsModule } from '../providers/spi-defaults.module';
import { EmbeddedPolicyEngine } from '../providers/embedded-policy-engine';
import type { PolicyEngineSPI } from '@aegisci/core/spi';
import type { AuthorizeRequest, AuthorizeResult } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Shadow PolicyEngine —— OPA 占位实现（只读对比）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class ShadowPolicyEngine implements PolicyEngineSPI {
  private policyVersion = 'shadow-v0';
  private rules: Array<{ id: string; effect: string; action: string; resource: string }> = [];

  setRules(rules: Array<{ id: string; effect: string; action: string; resource: string }>): void {
    this.rules = rules;
  }

  getPolicyVersion(): string { return this.policyVersion; }

  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const matched = this.firstMatch(req);
    if (!matched) return this.deny(req, 'DEFAULT_DENY');
    if (matched.effect === 'allow') return this.allow(req, matched.id);
    return this.deny(req, `DENY:${matched.id}`, matched.id);
  }

  async simulate(_req: AuthorizeRequest): Promise<AuthorizeResult> {
    return {
      decision: 'HALLOW',
      evidence: { evidenceId: 'shadow-sim', policyVersion: this.policyVersion, decision: 'HALLOW' as const, reason: 'simulate', rules: [], timestamp: new Date().toISOString() },
      cacheHit: false,
    };
  }

  async healthy(): Promise<boolean> { return true; }

  private firstMatch(req: AuthorizeRequest): { id: string; effect: string } | null {
    let firstAllow: { id: string; effect: string } | null = null;
    for (const rule of this.rules) {
      if (this.matches(rule, req)) {
        if (rule.effect === 'deny') return rule; // deny-wins
        if (firstAllow === null) firstAllow = rule;
      }
    }
    return firstAllow;
  }

  private matches(rule: { action: string; resource: string; effect: string }, req: AuthorizeRequest): boolean {
    const actionOk = rule.action === '*' || rule.action === req.action;
    let resourceOk = false;
    if (rule.resource === '*') {
      resourceOk = true;
    } else if (rule.resource.endsWith('/*')) {
      resourceOk = req.resource.startsWith(rule.resource.slice(0, -1)); // 'repo/*' → 'repo/'
    } else {
      resourceOk = rule.resource === req.resource;
    }
    return actionOk && resourceOk;
  }

  private ts(): string { return new Date().toISOString(); }

  private allow(_req: AuthorizeRequest, ruleId: string): AuthorizeResult {
    return {
      decision: 'ALLOW',
      evidence: { evidenceId: `shadow-ev-${ruleId}`, policyVersion: this.policyVersion, decision: 'ALLOW' as const, reason: `allowed by ${ruleId}`, rules: [ruleId], timestamp: this.ts() },
      cacheHit: false,
    };
  }

  private deny(_req: AuthorizeRequest, reason: string, ruleId?: string): AuthorizeResult {
    return {
      decision: 'DENY',
      evidence: { evidenceId: `shadow-deny-${reason}`, policyVersion: this.policyVersion, decision: 'DENY' as const, reason, rules: ruleId ? [ruleId] : [], timestamp: this.ts() },
      cacheHit: false,
    };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ShadowModeVerifier —— 双引擎裁决一致性验证器
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
class ShadowModeVerifier {
  constructor(
    private readonly primary: EmbeddedPolicyEngine,
    private readonly shadow: ShadowPolicyEngine,
  ) {}

  async compare(req: AuthorizeRequest): Promise<{ consistent: boolean; primaryDecision: string; shadowDecision: string }> {
    const [p, s] = await Promise.all([this.primary.authorize(req), this.shadow.authorize(req)]);
    return { consistent: p.decision === s.decision, primaryDecision: p.decision, shadowDecision: s.decision };
  }

  async validateBatch(requests: AuthorizeRequest[]): Promise<{ consistent: number; inconsistent: Array<{ req: AuthorizeRequest; primary: string; shadow: string }> }> {
    const results = await Promise.all(requests.map(r => this.compare(r)));
    let consistent = 0;
    const inconsistent: Array<{ req: AuthorizeRequest; primary: string; shadow: string }> = [];
    for (let i = 0; i < requests.length; i++) {
      if (results[i].consistent) { consistent++; } else { inconsistent.push({ req: requests[i], primary: results[i].primaryDecision, shadow: results[i].shadowDecision }); }
    }
    return { consistent, inconsistent };
  }

  async consistencyRate(requests: AuthorizeRequest[]): Promise<number> {
    const { consistent } = await this.validateBatch(requests);
    return consistent / requests.length;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试套件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-3 PolicyEngine Shadow Mode 双引擎并行验证', () => {
  let verifier: ShadowModeVerifier;
  let primary: EmbeddedPolicyEngine;
  let shadow: ShadowPolicyEngine;

  const makeReq = (action: string, resource: string): AuthorizeRequest => ({
    principal: { id: 'agent-1', type: 'agent', tenantId: 't1', roles: [] },
    action, resource, context: {},
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] }).compile();
    await moduleRef.init();
    primary = moduleRef.get<EmbeddedPolicyEngine>(EmbeddedPolicyEngine);
    shadow = new ShadowPolicyEngine();
    verifier = new ShadowModeVerifier(primary, shadow);

    const rules: Array<{ id: string; effect: 'allow' | 'deny'; action: string; resource: string }> = [
      { id: 'r1', effect: 'allow', action: 'read', resource: 'repo/*' },
      { id: 'r2', effect: 'deny', action: 'write', resource: 'repo/*' },
      { id: 'r3', effect: 'allow', action: '*', resource: 'config/public/*' },
    ];
    primary.loadRules(rules);
    shadow.setRules(rules);
  });

  it('L6-3-1: default deny consistent with primary', async () => {
    const result = await verifier.compare(makeReq('delete', 'repo/x'));
    expect(result.consistent).toBe(true);
    expect(result.primaryDecision).toBe('DENY');
    expect(result.shadowDecision).toBe('DENY');
  });

  it('L6-3-2: allow rule consistent', async () => {
    const result = await verifier.compare(makeReq('read', 'repo/x'));
    expect(result.consistent).toBe(true);
    expect(result.primaryDecision).toBe('ALLOW');
    expect(result.shadowDecision).toBe('ALLOW');
  });

  it('L6-3-3: deny rule consistent', async () => {
    const result = await verifier.compare(makeReq('write', 'repo/x'));
    expect(result.consistent).toBe(true);
    expect(result.primaryDecision).toBe('DENY');
    expect(result.shadowDecision).toBe('DENY');
  });

  it('L6-3-4: wildcard action consistent', async () => {
    const result = await verifier.compare(makeReq('list', 'config/public/settings'));
    expect(result.consistent).toBe(true);
    expect(result.primaryDecision).toBe('ALLOW');
    expect(result.shadowDecision).toBe('ALLOW');
  });

  it('L6-3-5: batch validation 100% consistent', async () => {
    const requests = [
      makeReq('read', 'repo/x'), makeReq('write', 'repo/x'), makeReq('delete', 'repo/x'),
      makeReq('list', 'config/public/settings'), makeReq('update', 'config/private/settings'),
    ];
    const { consistent, inconsistent } = await verifier.validateBatch(requests);
    expect(consistent).toBe(requests.length);
    expect(inconsistent).toHaveLength(0);
  });

  it('L6-3-6: consistency rate 100% for matching rule sets', async () => {
    const requests = Array.from({ length: 20 }, (_, i) => makeReq(i % 2 === 0 ? 'read' : 'write', `repo/item-${i}`));
    const rate = await verifier.consistencyRate(requests);
    expect(rate).toBe(1.0);
  });

  it('L6-3-7: inconsistent rules detected and flagged', async () => {
    shadow.setRules([{ id: 's1', effect: 'allow', action: 'write', resource: 'repo/*' }]);
    const result = await verifier.compare(makeReq('write', 'repo/x'));
    expect(result.consistent).toBe(false);
    expect(result.primaryDecision).toBe('DENY');
    expect(result.shadowDecision).toBe('ALLOW');
  });

  it('L6-3-8: shadow mode does not affect primary engine', async () => {
    const before = await primary.authorize(makeReq('read', 'repo/x'));
    expect(before.decision).toBe('ALLOW');
    shadow.setRules([{ id: 's1', effect: 'deny', action: '*', resource: '*' }]);
    const after = await primary.authorize(makeReq('read', 'repo/x'));
    expect(after.decision).toBe('ALLOW');
    expect(primary.getPolicyVersion()).toBe('v0');
  });

  it('L6-3-9: deny-wins conflict resolution consistent', async () => {
    const conflictRules = [
      { id: 'allow-r', effect: 'allow' as const, action: 'exec', resource: 'app/*' },
      { id: 'deny-r', effect: 'deny' as const, action: 'exec', resource: 'app/*' },
    ];
    primary.loadRules(conflictRules);
    shadow.setRules(conflictRules);
    const result = await verifier.compare(makeReq('exec', 'app/cmd'));
    expect(result.consistent).toBe(true);
    expect(result.primaryDecision).toBe('DENY');
    expect(result.shadowDecision).toBe('DENY');
  });

  it('L6-3-10: deny-wins over first-match when both match', async () => {
    // deny-wins-on-conflict：allow 和 deny 都匹配时，deny 优先
    const orderRules = [
      { id: 'first', effect: 'allow' as const, action: 'run', resource: '*' },
      { id: 'second', effect: 'deny' as const, action: 'run', resource: '*' },
    ];
    primary.loadRules(orderRules);
    shadow.setRules(orderRules);
    const result = await verifier.compare(makeReq('run', 'anything'));
    expect(result.consistent).toBe(true);
    // deny-wins：两个引擎都返回 DENY
    expect(result.primaryDecision).toBe('DENY');
    expect(result.shadowDecision).toBe('DENY');
  });
});
