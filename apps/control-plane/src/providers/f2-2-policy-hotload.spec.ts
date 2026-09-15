/**
 * F2-2 策略热加载测试
 *
 * 覆盖 GitPolicyLoader 热加载能力：
 * - 初始加载策略
 * - 热更新（新版本替换旧版本）
 * - 版本回滚
 * - Shadow Mode 双引擎加载
 * - 历史记录管理
 */

import { Test } from '@nestjs/testing';
import { GitPolicyLoader, type PolicyVersion } from '../providers/git-policy-loader';
import { DslCompiler } from '../providers/dsl-parser';
import type { PolicyRule } from '@aegisci/core/spi';

// ── 测试数据工厂 ──────────────────────────────────────────────────────

function makeRules(...entries: Array<{ id: string; effect: 'allow' | 'deny'; action: string; resource: string }>): PolicyRule[] {
  return entries.map(e => ({ ...e, condition: undefined }));
}

function makeDslJson(rules: PolicyRule[], version = 'v1'): string {
  return JSON.stringify({ version, rules });
}

// ── 辅助函数 ────────────────────────────────────────────────────────────

async function createLoader(
  source: () => Promise<{ content: string; version: string }>,
  maxHistorySize?: number,
): Promise<GitPolicyLoader> {
  const moduleRef = await Test.createTestingModule({
    providers: [{
      provide: GitPolicyLoader,
      useFactory: () => maxHistorySize !== undefined
        ? new GitPolicyLoader(source, maxHistorySize)
        : new GitPolicyLoader(source),
    }],
  }).compile();
  return moduleRef.get<GitPolicyLoader>(GitPolicyLoader);
}

// ── 基础加载测试 ────────────────────────────────────────────────────────

describe('F2-2 GitPolicyLoader: basic load', () => {
  it('loads initial policy and activates it', async () => {
    const source = jest.fn().mockResolvedValue({
      content: makeDslJson(makeRules({ id: 'r1', effect: 'allow', action: 'tool.exec', resource: 'repo/*' })),
      version: 'abc1234',
    });
    const loader = await createLoader(source);
    const pv = await loader.loadAndActivate();
    expect(pv.version).toBe('abc1234');
    expect(pv.ast.rules).toHaveLength(1);
    expect(loader.getActiveVersion()).toBe(pv);
    expect(pv.loadedAt).toBeInstanceOf(Date);
  });

  it('compiles and stores rules in AST', async () => {
    const source = jest.fn().mockResolvedValue({
      content: makeDslJson([
        { id: 'allow-exec', effect: 'allow', action: 'tool.exec', resource: 'repo/*', condition: undefined },
        { id: 'deny-prod',  effect: 'deny',  action: 'tool.exec', resource: 'repo/prod/*', condition: undefined },
      ]),
      version: 'v2',
    });
    const loader = await createLoader(source);
    const pv = await loader.loadAndActivate();
    expect(pv.ast.rules).toHaveLength(2);
    expect(pv.ast.rules[0].id).toBe('allow-exec');
    expect(pv.ast.rules[1].id).toBe('deny-prod');
  });

  it('records policy in history', async () => {
    const source = jest.fn().mockResolvedValue({
      content: makeDslJson(makeRules({ id: 'r1', effect: 'allow', action: 'x', resource: 'y' })),
      version: 'v1',
    });
    const loader = await createLoader(source);
    await loader.loadAndActivate();
    expect(loader.getHistory()).toHaveLength(1);
    expect(loader.getHistory()[0].version).toBe('v1');
  });
});

// ── 热更新测试 ──────────────────────────────────────────────────────────

describe('F2-2 GitPolicyLoader: hot reload', () => {
  it('replaces active version on subsequent load', async () => {
    let callCount = 0;
    const source = jest.fn().mockImplementation(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          content: makeDslJson(makeRules({ id: 'old', effect: 'allow', action: 'x', resource: 'y' })),
          version: 'v1',
        };
      }
      return {
        content: makeDslJson(makeRules({ id: 'new', effect: 'deny', action: 'x', resource: 'y' })),
        version: 'v2',
      };
    });
    const loader = await createLoader(source);

    const pv1 = await loader.loadAndActivate();
    expect(pv1.version).toBe('v1');
    expect(pv1.ast.rules[0].id).toBe('old');

    const pv2 = await loader.loadAndActivate();
    expect(pv2.version).toBe('v2');
    expect(pv2.ast.rules[0].id).toBe('new');
    expect(loader.getActiveVersion()?.version).toBe('v2');
  });

  it('builds history with multiple reloads', async () => {
    const versions = ['v1', 'v2', 'v3'];
    const source = jest.fn().mockImplementation(async () => {
      const v = versions.shift()!;
      return {
        content: makeDslJson(makeRules({ id: `rule-${v}`, effect: 'allow', action: 'x', resource: 'y' })),
        version: v,
      };
    });
    const loader = await createLoader(source);

    for (const _ of [1, 2, 3]) {
      await loader.loadAndActivate();
    }

    const history = loader.getHistory();
    expect(history).toHaveLength(3);
    expect(history[0].version).toBe('v1');
    expect(history[1].version).toBe('v2');
    expect(history[2].version).toBe('v3');
    expect(loader.getActiveVersion()?.version).toBe('v3');
  });
});

// ── 版本回滚测试 ────────────────────────────────────────────────────────

describe('F2-2 GitPolicyLoader: rollback', () => {
  it('rolls back to a previous version', async () => {
    const source = jest.fn().mockResolvedValue({
      content: makeDslJson(makeRules({ id: 'current', effect: 'allow', action: 'x', resource: 'y' })),
      version: 'v2',
    });
    const loader = await createLoader(source);

    // 先加载 v1
    await loader.loadFromDsl(
      makeDslJson(makeRules({ id: 'old-rule', effect: 'deny', action: 'x', resource: 'y' })),
      'v1',
    );
    // 再加载 v2
    await loader.loadAndActivate();

    // 回滚到 v1
    const rolledBack = await loader.rollbackTo('v1');
    expect(rolledBack.version).toBe('v1');
    expect(rolledBack.ast.rules[0].id).toBe('old-rule');
    expect(loader.getActiveVersion()?.version).toBe('v1');
  });

  it('throws when rolling back to unknown version', async () => {
    const source = jest.fn().mockResolvedValue({
      content: makeDslJson(makeRules({ id: 'r1', effect: 'allow', action: 'x', resource: 'y' })),
      version: 'v1',
    });
    const loader = await createLoader(source);
    await loader.loadAndActivate();

    await expect(loader.rollbackTo('nonexistent')).rejects.toThrow('not found in history');
  });
});

// ── Shadow Mode 测试 ────────────────────────────────────────────────────

describe('F2-2 GitPolicyLoader: shadow mode', () => {
  it('loads shadow version without replacing active', async () => {
    const source = jest.fn().mockResolvedValue({
      content: makeDslJson(makeRules({ id: 'active-rule', effect: 'allow', action: 'x', resource: 'y' })),
      version: 'v-active',
    });
    const loader = await createLoader(source);
    await loader.loadAndActivate();

    const shadowPv = await loader.loadFromDsl(
      makeDslJson(makeRules({ id: 'shadow-rule', effect: 'deny', action: 'x', resource: 'y' })),
      'v-shadow',
      true, // shadow mode
    );

    expect(loader.getActiveVersion()?.version).toBe('v-active');
    expect(loader.getShadowVersion()?.version).toBe('v-shadow');
    expect(loader.getShadowVersion()?.ast.rules[0].id).toBe('shadow-rule');
  });

  it('clears shadow version after clearShadow()', async () => {
    const loader = await createLoader(jest.fn().mockResolvedValue({
      content: makeDslJson(makeRules({ id: 'r1', effect: 'allow', action: 'x', resource: 'y' })),
      version: 'v1',
    }));
    await loader.loadFromDsl(
      makeDslJson(makeRules({ id: 'shadow-r', effect: 'deny', action: 'x', resource: 'y' })),
      'v-shadow',
      true,
    );
    expect(loader.getShadowVersion()).not.toBeNull();
    loader.clearShadow();
    expect(loader.getShadowVersion()).toBeNull();
  });
});

// ── 边界场景测试 ────────────────────────────────────────────────────────

describe('F2-2 GitPolicyLoader: edge cases', () => {
  it('warns but loads rules with conflicts', async () => {
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const source = jest.fn().mockResolvedValue({
      content: makeDslJson([
        { id: 'r1', effect: 'allow', action: '*', resource: '*', condition: undefined },
        { id: 'r2', effect: 'deny',  action: 'tool.exec', resource: 'repo/*', condition: undefined },
      ]),
      version: 'v-conflict',
    });
    const loader = await createLoader(source);
    // 应成功加载（带告警），不抛异常
    const pv = await loader.loadAndActivate();
    expect(pv.version).toBe('v-conflict');
    warnSpy.mockRestore();
  });

  it('throws when DSL compile fails', async () => {
    const source = jest.fn().mockResolvedValue({
      content: '{ invalid json',
      version: 'v-bad',
    });
    const loader = await createLoader(source);
    await expect(loader.loadAndActivate()).rejects.toThrow('DSL compile failed');
  });

  it('respects maxHistorySize', async () => {
    let callCount = 0;
    const source = jest.fn().mockImplementation(async () => {
      callCount++;
      return {
        content: makeDslJson(makeRules({ id: `r${callCount}`, effect: 'allow', action: 'x', resource: 'y' })),
        version: `v${callCount}`,
      };
    });
    const loader = await createLoader(source, 3); // max 3 history entries

    for (let i = 0; i < 5; i++) {
      await loader.loadAndActivate();
    }

    const history = loader.getHistory();
    expect(history).toHaveLength(3);
    // 最旧的 2 条被丢弃，保留最后 3 条
    expect(history[0].version).toBe('v3');
    expect(history[2].version).toBe('v5');
  });

  it('reset() clears all state', async () => {
    const loader = await createLoader(jest.fn().mockResolvedValue({
      content: makeDslJson(makeRules({ id: 'r1', effect: 'allow', action: 'x', resource: 'y' })),
      version: 'v1',
    }));
    await loader.loadAndActivate();
    loader.reset();
    expect(loader.getActiveVersion()).toBeNull();
    expect(loader.getShadowVersion()).toBeNull();
    expect(loader.getHistory()).toHaveLength(0);
  });
});
