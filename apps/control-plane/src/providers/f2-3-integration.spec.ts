/**
 * F2-3 GitPolicyStore 集成测试
 *
 * 覆盖 GitPolicyStore 作为 PolicyEngineSPI 实现的完整能力：
 * - 策略加载与裁决一致性（与 EmbeddedPolicyEngine 对齐）
 * - 热加载后裁决结果正确
 * - 版本回滚后裁决恢复
 * - Shadow Mode 验证通过后激活
 * - 与 ToolCallAuthorizeGuard 的集成
 */

import { Test } from '@nestjs/testing';
import type { AuthorizeRequest } from '@aegisci/shared/types';
import { SpiDefaultsModule } from '../providers/spi-defaults.module';
import { GitPolicyLoader, type PolicyVersion } from '../providers/git-policy-loader';
import { GitPolicyStore } from '../providers/git-policy-store';
import { ToolCallAuthorizeGuard } from '../guards/tool-call-authorize.guard';
import { SPI_TOKENS } from '@aegisci/core/spi';
import type { PolicyEngineSPI, PolicyRule } from '@aegisci/core/spi';

// ── 辅助函数 ────────────────────────────────────────────────────────────

function makeRules(...entries: Array<{ id: string; effect: 'allow' | 'deny'; action: string; resource: string }>): PolicyRule[] {
  return entries.map(e => ({ ...e, condition: undefined }));
}

function makeDslJson(rules: PolicyRule[], version = 'v1'): string {
  return JSON.stringify({ version, rules });
}

function makeReq(action: string, resource: string): AuthorizeRequest {
  return {
    principal: { id: 'agent-1', type: 'agent', tenantId: 't1', roles: [] },
    action,
    resource,
    context: {},
  };
}

// ── F2-3-1 策略加载与裁决一致性 ──────────────────────────────────────────

describe('F2-3-1 GitPolicyStore: load and authorize consistency', () => {
  let store: GitPolicyStore;
  let loader: GitPolicyLoader;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SpiDefaultsModule],
    }).compile();
    loader = new GitPolicyLoader(async () => ({
      content: makeDslJson([
        { id: 'allow-exec', effect: 'allow', action: 'tool.exec', resource: 'repo/*', condition: undefined },
        { id: 'deny-prod',  effect: 'deny',  action: 'tool.exec', resource: 'repo/prod/*', condition: undefined },
      ]),
      version: 'abc1234',
    }));
    store = new GitPolicyStore(loader);
  });

  it('initial state: no policy loaded → all DENY', async () => {
    const result = await store.authorize(makeReq('tool.exec', 'repo/x'));
    expect(result.decision).toBe('DENY');
    expect(result.evidence.reason).toBe('DEFAULT_DENY');
  });

  it('after loadFromGit, authorize respects loaded rules', async () => {
    await store.loadFromGit();

    // 匹配 allow 规则
    const allowResult = await store.authorize(makeReq('tool.exec', 'repo/x'));
    expect(allowResult.decision).toBe('ALLOW');
    expect(allowResult.evidence.reason).toBe('ALLOW:allow-exec');
    expect(allowResult.evidence.rules).toEqual(['allow-exec']);

    // 匹配 deny 规则
    const denyResult = await store.authorize(makeReq('tool.exec', 'repo/prod/file.txt'));
    expect(denyResult.decision).toBe('DENY');
    expect(denyResult.evidence.reason).toBe('DENY:deny-prod');
    expect(denyResult.evidence.rules).toEqual(['deny-prod']);

    // 无匹配 → DEFAULT_DENY
    const defaultDeny = await store.authorize(makeReq('git.push', 'repo/x'));
    expect(defaultDeny.decision).toBe('DENY');
    expect(defaultDeny.evidence.reason).toBe('DEFAULT_DENY');
  });

  it('policy version reflects loaded version', async () => {
    await store.loadFromGit();
    expect(store.getPolicyVersion()).toBe('abc1234');
  });

  it('ruleCount reflects loaded rules', async () => {
    await store.loadFromGit();
    expect(store.ruleCount()).toBe(2);
  });

  it('simulate() aligns with authorize()', async () => {
    await store.loadFromGit();
    const auth = await store.authorize(makeReq('tool.exec', 'repo/prod/file.txt'));
    const sim = await store.simulate(makeReq('tool.exec', 'repo/prod/file.txt'));
    expect(sim.decision).toBe(auth.decision);
    expect(sim.evidence.rules).toEqual(auth.evidence.rules);
  });
});

// ── F2-3-2 热加载测试 ────────────────────────────────────────────────────

describe('F2-3-2 GitPolicyStore: hot reload', () => {
  let store: GitPolicyStore;
  let currentVersion = 1;

  beforeEach(() => {
    const loader = new GitPolicyLoader(async () => {
      const v = `v${currentVersion}`;
      const isProdDeny = currentVersion === 2;
      return {
        content: makeDslJson([
          { id: 'allow-exec', effect: 'allow', action: 'tool.exec', resource: 'repo/*', condition: undefined },
          ...(isProdDeny ? [{ id: 'deny-prod', effect: 'deny', action: 'tool.exec', resource: 'repo/prod/*', condition: undefined }] : []),
        ]),
        version: v,
      };
    });
    store = new GitPolicyStore(loader);
  });

  it('hot reload changes active rules and version', async () => {
    await store.loadFromGit();
    expect(store.getPolicyVersion()).toBe('v1');
    expect(store.ruleCount()).toBe(1);

    // 热加载新版本
    currentVersion = 2;
    const pv = await store.loadFromGit();
    expect(pv.version).toBe('v2');
    expect(store.getPolicyVersion()).toBe('v2');
    expect(store.ruleCount()).toBe(2);

    // 新版本下 prod 被拒绝
    const result = await store.authorize(makeReq('tool.exec', 'repo/prod/file.txt'));
    expect(result.decision).toBe('DENY');
    expect(result.evidence.rules).toEqual(['deny-prod']);
  });

  it('hot reload preserves deny-wins semantics', async () => {
    const loader = new GitPolicyLoader(async () => ({
      content: makeDslJson([
        { id: 'allow-all', effect: 'allow', action: '*', resource: '*', condition: undefined },
        { id: 'deny-specific', effect: 'deny', action: 'tool.exec', resource: 'repo/*', condition: undefined },
      ]),
      version: 'v-conflict',
    }));
    store = new GitPolicyStore(loader);
    await store.loadFromGit();

    const result = await store.authorize(makeReq('tool.exec', 'repo/x'));
    expect(result.decision).toBe('DENY');
    expect(result.evidence.reason).toBe('DENY:deny-specific');
  });
});

// ── F2-3-3 Shadow Mode 验证与切换 ────────────────────────────────────────

describe('F2-3-3 GitPolicyStore: shadow mode validation', () => {
  let store: GitPolicyStore;
  let loader: GitPolicyLoader;

  beforeEach(async () => {
    const baseLoader = new GitPolicyLoader(async () => ({
      content: makeDslJson([
        { id: 'allow-exec', effect: 'allow', action: 'tool.exec', resource: 'repo/*', condition: undefined },
      ]),
      version: 'v-active',
    }));
    loader = baseLoader;
    store = new GitPolicyStore(loader);
    await store.loadFromGit();
  });

  it('loads shadow version without affecting active', async () => {
    await loader.loadFromDsl(
      makeDslJson([
        { id: 'shadow-allow', effect: 'allow', action: 'tool.exec', resource: 'repo/*', condition: undefined },
        { id: 'shadow-deny',  effect: 'deny',  action: 'tool.exec', resource: 'repo/prod/*', condition: undefined },
      ]),
      'v-shadow',
      true,
    );

    // 活跃版本不受影响
    const activeResult = await store.authorize(makeReq('tool.exec', 'repo/prod/file.txt'));
    expect(activeResult.decision).toBe('ALLOW');

    // 影子版本存在
    expect(loader.getShadowVersion()?.version).toBe('v-shadow');
  });

  it('activateShadow() switches to shadow version', async () => {
    await loader.loadFromDsl(
      makeDslJson([
        { id: 'shadow-deny', effect: 'deny', action: 'tool.exec', resource: 'repo/*', condition: undefined },
      ]),
      'v-shadow',
      true,
    );

    store.activateShadow();
    expect(store.getPolicyVersion()).toBe('v-shadow');

    const result = await store.authorize(makeReq('tool.exec', 'repo/x'));
    expect(result.decision).toBe('DENY');
    expect(result.evidence.rules).toEqual(['shadow-deny']);
  });

  it('shadow activate only works when shadow version exists', async () => {
    // 没有影子版本时调用 activateShadow 不应报错
    expect(() => store.activateShadow()).not.toThrow();
    expect(store.getPolicyVersion()).toBe('v-active');
  });
});

// ── F2-3-4 回滚测试 ──────────────────────────────────────────────────────

describe('F2-3-4 GitPolicyStore: rollback', () => {
  it('rolls back to previous version and restores裁决', async () => {
    const loader = new GitPolicyLoader(async () => ({
      content: makeDslJson([
        { id: 'current-allow', effect: 'allow', action: 'tool.exec', resource: 'repo/*', condition: undefined },
      ]),
      version: 'v2',
    }));
    const store = new GitPolicyStore(loader);

    // 加载 v1
    await loader.loadFromDsl(
      makeDslJson([
        { id: 'old-deny', effect: 'deny', action: 'tool.exec', resource: 'repo/*', condition: undefined },
      ]),
      'v1',
    );

    // 加载 v2
    const pv2 = await loader.loadAndActivate();
    expect(pv2.version).toBe('v2');

    // 回滚到 v1
    const rolledBack = await loader.rollbackTo('v1');
    expect(rolledBack.version).toBe('v1');

    // store 需要手动同步（模拟外部驱动）
    store['activeRules'] = rolledBack.ast.rules;
    store['policyVersion'] = rolledBack.version;

    const result = await store.authorize(makeReq('tool.exec', 'repo/x'));
    expect(result.decision).toBe('DENY');
    expect(result.evidence.rules).toEqual(['old-deny']);
  });
});

// ── F2-3-5 与 ToolCallAuthorizeGuard 集成测试 ────────────────────────────

describe('F2-3-5 GitPolicyStore integration with ToolCallAuthorizeGuard', () => {
  it('guard blocks unauthorized tool calls after policy load', async () => {
    const loader = new GitPolicyLoader(async () => ({
      content: makeDslJson([
        { id: 'allow-exec', effect: 'allow', action: 'tool.exec', resource: 'repo/*', condition: undefined },
      ]),
      version: 'v1',
    }));
    const store = new GitPolicyStore(loader);
    await store.loadFromGit();

    const mockTool = {
      name: 'echo' as const,
      actions: jest.fn().mockReturnValue(['echo']),
      execute: jest.fn().mockResolvedValue({
        success: true,
        data: { echoed: {}, action: 'tool.exec', resource: 'repo/x' },
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      }),
      healthy: jest.fn().mockResolvedValue(true),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [SpiDefaultsModule],
      providers: [ToolCallAuthorizeGuard],
    })
      .overrideProvider(SPI_TOKENS.POLICY_ENGINE).useValue(store)
      .overrideProvider(SPI_TOKENS.TOOL_PROVIDER).useValue(mockTool)
      .compile();
    await moduleRef.init();

    const guard = moduleRef.get(ToolCallAuthorizeGuard);

    // 先授权
    const authResult = await guard.authorize({
      principal: { id: 'agent-1', type: 'agent', tenantId: 't1', roles: [] },
      action: 'tool.exec',
      resource: 'repo/x',
      context: {},
    });
    expect(authResult.decision).toBe('ALLOW');

    // 执行工具
    const execResult = await guard.execute({
      toolName: 'echo',
      action: 'tool.exec',
      resource: 'repo/x',
      args: {},
      agentId: 'agent-1',
      runId: 'run-1',
    });
    expect(execResult.success).toBe(true);
    expect(mockTool.execute).toHaveBeenCalled();
  });

  it('guard denies tool call when policy denies authorization', async () => {
    const loader = new GitPolicyLoader(async () => ({
      content: makeDslJson([
        { id: 'deny-exec', effect: 'deny', action: 'tool.exec', resource: 'repo/*', condition: undefined },
      ]),
      version: 'v1',
    }));
    const store = new GitPolicyStore(loader);
    await store.loadFromGit();

    const mockTool = {
      name: 'echo' as const,
      actions: jest.fn().mockReturnValue(['echo']),
      execute: jest.fn(),
      healthy: jest.fn().mockResolvedValue(true),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [SpiDefaultsModule],
      providers: [ToolCallAuthorizeGuard],
    })
      .overrideProvider(SPI_TOKENS.POLICY_ENGINE).useValue(store)
      .overrideProvider(SPI_TOKENS.TOOL_PROVIDER).useValue(mockTool)
      .compile();
    await moduleRef.init();

    const guard = moduleRef.get(ToolCallAuthorizeGuard);

    const authResult = await guard.authorize({
      principal: { id: 'agent-1', type: 'agent', tenantId: 't1', roles: [] },
      action: 'tool.exec',
      resource: 'repo/x',
      context: {},
    });
    expect(authResult.decision).toBe('DENY');

    // 未授权不得执行工具
    await expect(
      guard.execute({
        toolName: 'echo',
        action: 'tool.exec',
        resource: 'repo/x',
        args: {},
        agentId: 'agent-1',
        runId: 'run-1',
      }),
    ).rejects.toThrow('not authorized before execution');
    expect(mockTool.execute).not.toHaveBeenCalled();
  });
});
