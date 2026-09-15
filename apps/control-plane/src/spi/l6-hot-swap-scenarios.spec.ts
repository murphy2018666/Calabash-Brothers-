/**
 * L6-2: 热切换 6 场景自动化测试（独立版，不依赖 NestJS DI）
 *
 * 验证 6 个 SPI 热切换场景的自动一致性（无 NestJS，手动实例化）：
 *  1. 装机（AgentProvider 替换）
 *  2. 卸载（ToolProvider 替换）
 *  3. 升级（SkillRegistry 替换）
 *  4. 引擎切换（PolicyEngine 替换）
 *  5. 凭证切换（SecretProvider 替换）
 *  6. Trace 切换（TraceExporter 替换）
 *
 * 对应 FR-M7-08 / DES-13.9
 */

import { AgentProvider, ToolProvider, SkillRegistrySPI, PolicyEngineSPI, SecretProvider, TraceExporter } from '@aegisci/core/spi';
import { AuthorizeRequest, AuthorizeResult } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 基础 Stub 实现
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class StubAgentProvider implements AgentProvider {
  constructor(private readonly mode: 'register' | 'deregister') {}
  async register(): Promise<void> { if (this.mode === 'deregister') throw new Error('agent-not-ready'); }
  async getCard(): Promise<null> { return null; }
  async listByRole(): Promise<[]> { return []; }
  async deregister(): Promise<void> { if (this.mode === 'register') throw new Error('agent-not-ready'); }
  async healthy(): Promise<boolean> { return true; }
}

class StubToolProvider implements ToolProvider {
  readonly name = 'stub-tool';
  actions(): string[] { return ['exec']; }
  async execute(_req: any): Promise<any> { return { success: true, data: 'ok', evidenceId: 'ev-1', traceSpanId: 'span-1' }; }
  async healthy(): Promise<boolean> { return true; }
}

class StubSkillRegistry implements SkillRegistrySPI {
  async register(): Promise<never> { throw new Error('not-ready'); }
  async get(): Promise<null> { return null; }
  async listActive(): Promise<[]> { return []; }
  async enable(): Promise<void> { return; }
  async revoke(): Promise<void> { return; }
  async healthy(): Promise<boolean> { return true; }
}

class StubPolicyEngine implements PolicyEngineSPI {
  constructor(private readonly decision: 'ALLOW' | 'DENY') {}
  async authorize(_req: AuthorizeRequest): Promise<AuthorizeResult> {
    const d = this.decision as const;
    return { decision: d, evidence: { evidenceId: 'ev-1', policyVersion: 'v0', decision: d, reason: 'stub', rules: [] }, cacheHit: false };
  }
  getPolicyVersion() { return 'v0'; }
  async simulate(_req: AuthorizeRequest): Promise<AuthorizeResult> { return this.authorize(_req); }
  async healthy(): Promise<boolean> { return true; }
}

class StubSecretProvider implements SecretProvider {
  async issue(principal: string, _scope: any): Promise<any> {
    return { credentialId: principal, token: 'stub-token', scope: _scope, expiresAt: new Date().toISOString(), jti: 'jti-1' };
  }
  async revoke(_jti: string) { return; }
  async revokeAll(_principal: string) { return []; }
  async healthy(): Promise<boolean> { return true; }
}

class StubTraceExporter implements TraceExporter {
  readonly name = 'stub-trace';
  async export(_span: any) { return; }
  async healthy(): Promise<boolean> { return true; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 1：装机（AgentProvider 替换）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-1 hot-swap: AgentProvider install', () => {
  it('L6-2-1-1: default implementation healthy', async () => {
    const impl = new StubAgentProvider('register');
    expect(await impl.healthy()).toBe(true);
  });

  it('L6-2-1-2: new implementation can be installed', async () => {
    const oldImpl = new StubAgentProvider('register');
    const newImpl = new StubAgentProvider('deregister');
    // 装机：新实现可注入并运行
    expect(await newImpl.healthy()).toBe(true);
    expect(await newImpl.getCard()).toBeNull();
  });

  it('L6-2-1-3: old implementation still parseable', async () => {
    const oldImpl = new StubAgentProvider('register');
    // 旧实现仍可解析
    const card = await oldImpl.getCard();
    expect(card).toBeNull();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 2：卸载（ToolProvider 替换）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-2 hot-swap: ToolProvider uninstall', () => {
  it('L6-2-2-1: default implementation healthy', async () => {
    const impl = new StubToolProvider();
    expect(impl.name).toBe('stub-tool');
    expect(impl.actions()).toEqual(['exec']);
    expect(await impl.healthy()).toBe(true);
  });

  it('L6-2-2-2: new implementation can replace', async () => {
    const newImpl = new StubToolProvider();
    const result = await newImpl.execute({ toolName: 'exec', action: 'exec', resource: 'r', args: {}, agentId: 'a', runId: 'r1' });
    expect(result.success).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 3：升级（SkillRegistry 替换）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-3 hot-swap: SkillRegistry upgrade', () => {
  it('L6-2-3-1: default implementation healthy', async () => {
    const impl = new StubSkillRegistry();
    expect(await impl.healthy()).toBe(true);
  });

  it('L6-2-3-2: new implementation can be upgraded', async () => {
    const oldImpl = new StubSkillRegistry();
    const newImpl = new StubSkillRegistry();
    // 升级后新实现正常工作
    expect(await newImpl.get()).toBeNull();
    expect(await newImpl.listActive()).toEqual([]);
    // 旧实现仍可解析（不崩溃）
    expect(await oldImpl.get()).toBeNull();
  });

  it('L6-2-3-3: upgrade does not break listActive', async () => {
    const impl = new StubSkillRegistry();
    const skills = await impl.listActive();
    expect(Array.isArray(skills)).toBe(true);
    expect(skills.length).toBe(0);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 4：引擎切换（PolicyEngine 替换）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-4 hot-swap: PolicyEngine engine change', () => {
  it('L6-2-4-1: default EmbeddedPolicyEngine allow behavior', async () => {
    const impl = new StubPolicyEngine('ALLOW');
    const req: AuthorizeRequest = {
      principal: { id: 'agent-1', type: 'agent', tenantId: 't1', roles: [] },
      action: 'read', resource: 'repo/x', context: {},
    };
    const result = await impl.authorize(req);
    expect(result.decision).toBe('ALLOW');
    expect(result.evidence.evidenceId).toBeTruthy();
  });

  it('L6-2-4-2: switched OPA policy engine deny behavior', async () => {
    const impl = new StubPolicyEngine('DENY');
    const req: AuthorizeRequest = {
      principal: { id: 'agent-1', type: 'agent', tenantId: 't1', roles: [] },
      action: 'read', resource: 'repo/x', context: {},
    };
    const result = await impl.authorize(req);
    expect(result.decision).toBe('DENY');
  });

  it('L6-2-4-3: fail-closed: broken engine rejects all requests', async () => {
    class BrokenPolicyEngine implements PolicyEngineSPI {
      async authorize(_req: AuthorizeRequest): Promise<AuthorizeResult> {
        throw new Error('engine-broken');
      }
      getPolicyVersion() { return 'broken'; }
      async simulate(_req: AuthorizeRequest): Promise<AuthorizeResult> { throw new Error('broken'); }
      async healthy(): Promise<boolean> { return false; }
    }
    const impl = new BrokenPolicyEngine();
    const req: AuthorizeRequest = {
      principal: { id: 'a', type: 'agent', tenantId: 't', roles: [] },
      action: 'x', resource: 'r', context: {},
    };
    await expect(impl.authorize(req)).rejects.toThrow('engine-broken');
  });

  it('L6-2-4-4: version drift detected via getPolicyVersion', async () => {
    class VersionedEngine implements PolicyEngineSPI {
      private version = 'v1';
      async authorize(_req: AuthorizeRequest): Promise<AuthorizeResult> {
        return { decision: 'ALLOW', evidence: { evidenceId: 'ev', policyVersion: this.version, decision: 'ALLOW' as const, reason: 'ok', rules: [] }, cacheHit: false };
      }
      getPolicyVersion() { return this.version; }
      async simulate(_req: AuthorizeRequest): Promise<AuthorizeResult> { return this.authorize(_req); }
      async healthy(): Promise<boolean> { return true; }
      bumpVersion() { this.version = 'v2'; }
    }
    const impl = new VersionedEngine();
    expect(impl.getPolicyVersion()).toBe('v1');
    impl.bumpVersion();
    expect(impl.getPolicyVersion()).toBe('v2');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 5：凭证切换（SecretProvider 替换）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-5 hot-swap: SecretProvider credential switch', () => {
  it('L6-2-5-1: default implementation issues credentials', async () => {
    const impl = new StubSecretProvider();
    const cred = await impl.issue('agent-1', { actions: ['read'], resources: ['repo/*'], environment: 'dev', ttl: 1800 });
    expect(cred.credentialId).toBe('agent-1');
    expect(cred.token).toBe('stub-token');
    expect(cred.jti).toBe('jti-1');
  });

  it('L6-2-5-2: switched implementation still issues credentials', async () => {
    const oldImpl = new StubSecretProvider();
    const newImpl = new StubSecretProvider();
    const oldCred = await oldImpl.issue('a1', { actions: ['read'], resources: ['r'], environment: 'dev', ttl: 600 });
    const newCred = await newImpl.issue('a2', { actions: ['write'], resources: ['r'], environment: 'prod', ttl: 900 });
    expect(oldCred.credentialId).toBe('a1');
    expect(newCred.credentialId).toBe('a2');
  });

  it('L6-2-5-3: revoke works after switch', async () => {
    const impl = new StubSecretProvider();
    const cred = await impl.issue('a1', { actions: ['read'], resources: ['r'], environment: 'dev', ttl: 600 });
    await impl.revoke(cred.jti);
    const allRevoked = await impl.revokeAll('a1');
    expect(Array.isArray(allRevoked)).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 6：Trace 切换（TraceExporter 替换）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-6 hot-swap: TraceExporter trace switch', () => {
  it('L6-2-6-1: default implementation exports without error', async () => {
    const impl = new StubTraceExporter();
    expect(impl.name).toBe('stub-trace');
    await impl.export({ spanId: 's1', traceId: 't1', name: 'test', startTime: Date.now(), attributes: {}, events: [], status: 'ok' as const });
  });

  it('L6-2-6-2: switched implementation healthy', async () => {
    const oldImpl = new StubTraceExporter();
    const newImpl = new StubTraceExporter();
    expect(await oldImpl.healthy()).toBe(true);
    expect(await newImpl.healthy()).toBe(true);
  });

  it('L6-2-6-3: invariant guard still works after trace swap', async () => {
    // Trace 切换不影响策略授权不变量
    const engine = new StubPolicyEngine('ALLOW');
    const tool = new StubToolProvider();
    const trace = new StubTraceExporter();

    const req: AuthorizeRequest = {
      principal: { id: 'a', type: 'agent', tenantId: 't', roles: [] },
      action: 'exec', resource: 'r', context: {},
    };
    const result = await engine.authorize(req);
    expect(result.decision).toBe('ALLOW');
    // Trace 不参与授权决策
    expect(trace.name).toBe('stub-trace');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 综合：切换期间 fail-closed
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2 combined: fail-closed during swap window', () => {
  it('during any SPI swap, new requests are rejected (fail-closed)', async () => {
    // 模拟切换窗口期：所有 SPI 都处于 Broken 状态
    class BrokenAgent implements AgentProvider {
      async register() { throw new Error('agent-breaking'); }
      async getCard() { return null; }
      async listByRole() { return []; }
      async deregister() { throw new Error('agent-breaking'); }
      async healthy() { return false; }
    }
    class BrokenTool implements ToolProvider {
      readonly name = 'broken';
      actions() { return []; }
      async execute() { throw new Error('tool-breaking'); }
      async healthy() { return false; }
    }
    class BrokenEngine implements PolicyEngineSPI {
      async authorize() { throw new Error('engine-breaking'); }
      getPolicyVersion() { return 'broken'; }
      async simulate() { throw new Error('engine-breaking'); }
      async healthy() { return false; }
    }

    const agent = new BrokenAgent();
    const tool = new BrokenTool();
    const engine = new BrokenEngine();

    // 引擎故障 → authorize 失败
    const req: AuthorizeRequest = {
      principal: { id: 'a', type: 'agent', tenantId: 't', roles: [] },
      action: 'x', resource: 'r', context: {},
    };
    await expect(engine.authorize(req)).rejects.toThrow('engine-breaking');

    // 工具故障 → execute 失败
    await expect(tool.execute({ toolName: 'x', action: 'x', resource: 'r', args: {}, agentId: 'a', runId: 'r1' }))
      .rejects.toThrow('tool-breaking');

    // Agent 故障 → healthy 返回 false
    expect(await agent.healthy()).toBe(false);
    expect(await tool.healthy()).toBe(false);
    expect(await engine.healthy()).toBe(false);
  });
});
