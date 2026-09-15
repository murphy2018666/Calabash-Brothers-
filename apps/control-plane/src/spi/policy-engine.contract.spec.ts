import { Test } from '@nestjs/testing';
import type { AuthorizeRequest } from '@aegisci/shared/types';
import { EmbeddedPolicyEngine } from '../providers/embedded-policy-engine';

/**
 * SPI 契约测试 —— EmbeddedPolicyEngine 实现 PolicyEngineSPI 接口正确性
 * （DES-13.9：默认拒绝语义不变、裁决输出契约含 evidenceId、策略版本化；
 * L2-2：Cedar 风格 DSL —— 规则加载/allow 匹配/deny 优先/通配/版本联动）。
 */
describe('EmbeddedPolicyEngine (PolicyEngineSPI contract)', () => {
  let engine: EmbeddedPolicyEngine;

  const req = (overrides: Partial<AuthorizeRequest> = {}): AuthorizeRequest => ({
    principal: {
      id: 'agent-1',
      type: 'agent',
      tenantId: 'tenant-1',
      roles: [],
    },
    action: 'tool.exec',
    resource: 'repo/x',
    context: { env: 'development' },
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [EmbeddedPolicyEngine],
    }).compile();
    engine = moduleRef.get(EmbeddedPolicyEngine);
  });

  // ── S1 基线：默认拒绝契约 ────────────────────────────────

  it('authorize() returns DENY by default (default-deny)', async () => {
    const result = await engine.authorize(req());
    expect(result.decision).toBe('DENY');
  });

  it('authorize() evidence carries an evidenceId', async () => {
    const result = await engine.authorize(req());
    expect(result.evidence).toBeDefined();
    expect(result.evidence.evidenceId).toBeTruthy();
    expect(result.evidence.decision).toBe('DENY');
  });

  it('getPolicyVersion() returns the initial version "v0"', () => {
    expect(engine.getPolicyVersion()).toBe('v0');
  });

  it('policyVersion is trackable (setPolicyVersion)', () => {
    engine.setPolicyVersion('v1');
    expect(engine.getPolicyVersion()).toBe('v1');
  });

  it('simulate() works and returns a DENY result with evidence', async () => {
    const result = await engine.simulate(req());
    expect(result.decision).toBe('DENY');
    expect(result.evidence).toBeDefined();
    expect(result.evidence.evidenceId).toBeTruthy();
  });

  it('evidence.policyVersion aligns with getPolicyVersion()', async () => {
    engine.setPolicyVersion('v2');
    const result = await engine.authorize(req());
    expect(result.evidence.policyVersion).toBe('v2');
  });

  it('healthy() returns true', async () => {
    expect(await engine.healthy()).toBe(true);
  });

  // ── L2-2 DSL：规则加载与求值 ─────────────────────────────

  it('no rules loaded → ruleCount() = 0 and authorize is DEFAULT_DENY', async () => {
    expect(engine.ruleCount()).toBe(0);
    const result = await engine.authorize(req());
    expect(result.decision).toBe('DENY');
    expect(result.evidence.reason).toBe('DEFAULT_DENY');
  });

  it('loadRules() is overwriting (reloadable) and bumps ruleCount', () => {
    engine.loadRules([{ id: 'r1', effect: 'allow', action: 'tool.exec', resource: 'repo/*' }]);
    expect(engine.ruleCount()).toBe(1);
    engine.loadRules([]);
    expect(engine.ruleCount()).toBe(0);
  });

  it('allow rule matches → ALLOW with rule id in evidence.rules', async () => {
    engine.loadRules([
      { id: 'allow-exec', effect: 'allow', action: 'tool.exec', resource: 'repo/*' },
    ]);
    const result = await engine.authorize(req());
    expect(result.decision).toBe('ALLOW');
    expect(result.evidence.reason).toBe('ALLOW:allow-exec');
    expect(result.evidence.rules).toEqual(['allow-exec']);
  });

  it('deny rule wins over allow rule regardless of order (deny-wins-on-conflict)', async () => {
    engine.loadRules([
      { id: 'allow-all', effect: 'allow', action: '*', resource: '*' },
      { id: 'deny-prod', effect: 'deny', action: 'tool.exec', resource: 'repo/x' },
    ]);
    const denied = await engine.authorize(req());
    expect(denied.decision).toBe('DENY');
    expect(denied.evidence.reason).toBe('DENY:deny-prod');

    // 反向顺序同样 deny 优先
    engine.loadRules([
      { id: 'deny-prod', effect: 'deny', action: 'tool.exec', resource: 'repo/x' },
      { id: 'allow-all', effect: 'allow', action: '*', resource: '*' },
    ]);
    const denied2 = await engine.authorize(req());
    expect(denied2.decision).toBe('DENY');
  });

  it('action wildcard "*" matches any action', async () => {
    engine.loadRules([
      { id: 'allow-any', effect: 'allow', action: '*', resource: 'repo/x' },
    ]);
    const r1 = await engine.authorize(req({ action: 'tool.exec' }));
    const r2 = await engine.authorize(req({ action: 'git.push' }));
    expect(r1.decision).toBe('ALLOW');
    expect(r2.decision).toBe('ALLOW');
  });

  it('resource prefix "repo/*" matches repo/x and nested paths, not other prefixes', async () => {
    engine.loadRules([
      { id: 'allow-repos', effect: 'allow', action: 'tool.exec', resource: 'repo/*' },
    ]);
    expect((await engine.authorize(req({ resource: 'repo/x' }))).decision).toBe('ALLOW');
    expect((await engine.authorize(req({ resource: 'repo/a/b/c' }))).decision).toBe('ALLOW');
    expect((await engine.authorize(req({ resource: 'registry/x' }))).decision).toBe('DENY');
    // 非前缀边界：'repofoo' 不应命中 'repo/*'
    expect((await engine.authorize(req({ resource: 'repofoo' }))).decision).toBe('DENY');
  });

  it('no matching rule → DEFAULT_DENY even when other rules exist', async () => {
    engine.loadRules([
      { id: 'allow-git', effect: 'allow', action: 'git.read', resource: 'repo/*' },
    ]);
    const result = await engine.authorize(req({ action: 'tool.exec' }));
    expect(result.decision).toBe('DENY');
    expect(result.evidence.reason).toBe('DEFAULT_DENY');
    expect(result.evidence.rules).toEqual([]);
  });

  it('first-match-wins among same-effect rules', async () => {
    engine.loadRules([
      { id: 'first', effect: 'allow', action: 'tool.exec', resource: 'repo/x' },
      { id: 'second', effect: 'allow', action: 'tool.exec', resource: 'repo/x' },
    ]);
    const result = await engine.authorize(req());
    expect(result.evidence.rules).toEqual(['first']);
  });

  it('simulate() aligns with authorize() semantics (FR-M3-08)', async () => {
    engine.loadRules([
      { id: 'allow-exec', effect: 'allow', action: 'tool.exec', resource: 'repo/*' },
      { id: 'deny-prod', effect: 'deny', action: 'tool.exec', resource: 'repo/prod' },
    ]);
    const auth = await engine.authorize(req({ resource: 'repo/prod' }));
    const sim = await engine.simulate(req({ resource: 'repo/prod' }));
    expect(sim.decision).toBe(auth.decision);
    expect(sim.evidence.rules).toEqual(auth.evidence.rules);
  });

  it('version bump reflects in new evidence after rule reload', async () => {
    engine.loadRules([
      { id: 'allow-exec', effect: 'allow', action: 'tool.exec', resource: 'repo/*' },
    ]);
    engine.setPolicyVersion('v9');
    const result = await engine.authorize(req());
    expect(result.decision).toBe('ALLOW');
    expect(result.evidence.policyVersion).toBe('v9');
  });
});
