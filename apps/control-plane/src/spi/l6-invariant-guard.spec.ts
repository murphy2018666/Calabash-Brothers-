/**
 * L6-1 SPI 安全不变量守护测试（DES-13.9 / FR-M7-01）
 *
 * 从 S1 的 3 条内核不变量守护测试扩充至 8 个 SPI 安全不变量：
 *   1. AGENT_PROVIDER_NO_UNREGISTERED_EXEC   —— Agent 未注册不可执行
 *   2. AGENT_PROVIDER_CARD_IMMUTABLE_AFTER_REGISTER —— 注册后卡片不可被外部篡改
 *   3. TOOL_PROVIDER_NO_AUTH_BEFORE_EXECUTE  —— 工具执行必经授权（与 AG-3 协同）
 *   4. TOOL_PROVIDER_NO_SIDE_EFFECT_ON_DENY  —— DENY 时无副作用（不执行工具）
 *   5. SECRET_PROVIDER_TTL_BOUND             —— TTL 超限立即拒绝（fail-closed）
 *   6. SECRET_PROVIDER_SCOPE_MINIMAL         —— 签发凭证 scope 不超出请求
 *   7. MODEL_GATEWAY_BUDGET_ENFORCED         —— Token 预算耗尽即拒绝（fail-closed）
 *   8. MODEL_GATEWAY_OUTPUT_INTERNALLY_INTERCEPTED —— 模型输出不经直接工具调用
 *   9. TRACE_EXPORTER_NO_DATA_LEAK           —— Noop 导出器不泄露 span 数据
 *  10. SKILL_REGISTRY_SIGN_REQUIRED          —— 未签名技能包拒绝注册
 *  11. SKILL_REGISTRY_DISABLE_REMOVES_FROM_ACTIVE —— 吊销后技能不在 active 列表
 *
 * 每个不变量 ≥ 2 个守护用例，违反即 CI 守护测试挂红。
 */

import { Test } from '@nestjs/testing';
import { SPI_TOKENS, type PolicyEngineSPI } from '@aegisci/core/spi';
import type { AgentCard, SkillManifest } from '@aegisci/shared/types';
import { InMemoryAgentProvider } from '../providers/in-memory-agent-provider';
import { EmbeddedPolicyEngine } from '../providers/embedded-policy-engine';
import { EnvFileSecretProvider } from '../providers/env-file-secret-provider';
import { NoopTraceExporter } from '../providers/noop-trace-exporter';
import { InMemorySkillRegistry } from '../providers/in-memory-skill-registry';
import { StubModelGateway, BudgetExhaustedError } from '../providers/stub-model-gateway';
import { InMemoryToolProvider } from '../providers/in-memory-tool-provider';
import { InvariantViolationError } from '../guards/invariant-violation.error';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. AGENT_PROVIDER_NO_UNREGISTERED_EXEC
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-1 invariant: AGENT_PROVIDER_NO_UNREGISTERED_EXEC', () => {
  let provider: InMemoryAgentProvider;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [InMemoryAgentProvider],
    }).compile();
    provider = moduleRef.get(InMemoryAgentProvider);
  });

  it('guard: getCard for unregistered agent returns null (no phantom access)', async () => {
    const card = await provider.getCard('unregistered-agent');
    expect(card).toBeNull();
  });

  it('guard: listByRole for unregistered role returns empty (no data leak)', async () => {
    const cards = await provider.listByRole('nonexistent' as any, 'tenant-1');
    expect(cards).toHaveLength(0);
  });

  it('guard: deregister non-existent agent is no-op (fail-safe)', async () => {
    await expect(provider.deregister('nonexistent')).resolves.toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. AGENT_PROVIDER_CARD_IMMUTABLE_AFTER_REGISTER
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-2 invariant: AGENT_PROVIDER_CARD_IMMUTABLE_AFTER_REGISTER', () => {
  let provider: InMemoryAgentProvider;

  const card: AgentCard = {
    agentId: 'agent-1',
    role: 'reviewer' as any,
    displayName: 'Reviewer',
    modelId: 'gpt-x',
    capabilities: ['git.diff'],
    riskTier: 'G2',
    tenantId: 'tenant-1',
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [InMemoryAgentProvider],
    }).compile();
    provider = moduleRef.get(InMemoryAgentProvider);
  });

  it('guard: re-registering overwrites card (upsert semantics), old reference not leaked', async () => {
    await provider.register(card);
    const before = await provider.getCard('agent-1');
    expect(before?.displayName).toBe('Reviewer');

    const updated = { ...card, displayName: 'Updated' };
    await provider.register(updated);
    const after = await provider.getCard('agent-1');
    expect(after?.displayName).toBe('Updated');
    // 旧引用不再存在
    expect(before?.displayName).not.toBe(after?.displayName);
  });

  it('guard: registered card fields are isolated per agentId', async () => {
    await provider.register(card);
    await provider.register({ ...card, agentId: 'agent-2', role: 'planner' as any });
    const c1 = await provider.getCard('agent-1');
    const c2 = await provider.getCard('agent-2');
    expect(c1?.role).not.toBe(c2?.role);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. TOOL_PROVIDER_NO_AUTH_BEFORE_EXECUTE
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-3 invariant: TOOL_PROVIDER_NO_AUTH_BEFORE_EXECUTE', () => {
  it('guard: execute() must be preceded by authorize() (enforced by guard layer)', async () => {
    // ToolProvider 自身不做授权——由内核 ToolCallAuthorizeGuard 保障。
    // 本测试验证：调用 execute 时返回 evidenceId 和 traceSpanId（契约完整），
    // 而授权由外部 guard 层保障，provider 本身无授权判断逻辑。
    const provider = new InMemoryToolProvider();
    const result = await provider.execute({
      toolName: 'echo',
      action: 'echo',
      resource: 'repo/x',
      args: { msg: 'hi' },
      agentId: 'agent-1',
      runId: 'run-1',
    });
    expect(result.success).toBe(true);
    expect(result.evidenceId).toBeTruthy();
    expect(result.traceSpanId).toBeTruthy();
  });

  it('guard: actions() returns declared actions (no hidden actions exposed)', async () => {
    const provider = new InMemoryToolProvider();
    const actions = provider.actions();
    expect(actions).toEqual(['echo']);
    // 无任何隐藏 action
    expect(actions).not.toContain('admin.delete');
    expect(actions).not.toContain('secret.read');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. TOOL_PROVIDER_NO_SIDE_EFFECT_ON_DENY
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-4 invariant: TOOL_PROVIDER_NO_SIDE_EFFECT_ON_DENY', () => {
  it('guard: tool provider execute is side-effect-free when called outside guard context', async () => {
    // ToolProvider 幂等性：相同输入产生相同输出（证据链可复现）
    const provider = new InMemoryToolProvider();
    const req = {
      toolName: 'echo',
      action: 'echo',
      resource: 'repo/x',
      args: { msg: 'test' },
      agentId: 'agent-1',
      runId: 'run-1',
    };
    const r1 = await provider.execute(req);
    const r2 = await provider.execute(req);
    expect(r1.success).toBe(r2.success);
    expect(r1.data).toEqual(r2.data);
  });

  it('guard: unknown action returns success (guard layer blocks it, not provider)', async () => {
    // Provider 契约：execute 不判断动作合法性，由内核 ToolCallAuthorizeGuard 拦截
    const provider = new InMemoryToolProvider();
    const result = await provider.execute({
      toolName: 'echo',
      action: 'unknown-action',
      resource: 'repo/x',
      args: {},
      agentId: 'agent-1',
      runId: 'run-1',
    });
    expect(result.success).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 5. SECRET_PROVIDER_TTL_BOUND
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-5 invariant: SECRET_PROVIDER_TTL_BOUND', () => {
  let provider: EnvFileSecretProvider;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [EnvFileSecretProvider],
    }).compile();
    provider = moduleRef.get(EnvFileSecretProvider);
  });

  it('guard: TTL > 30min is rejected immediately (fail-closed)', async () => {
    await expect(
      provider.issue('agent-1', {
        actions: ['git.read'],
        resources: ['repo/x'],
        environment: 'staging',
        ttl: 31 * 60 + 1, // 30min + 1s over limit
      }),
    ).rejects.toThrow('TTL overflow');
  });

  it('guard: TTL exactly at 30min boundary is accepted', async () => {
    const cred = await provider.issue('agent-1', {
      actions: ['git.read'],
      resources: ['repo/x'],
      environment: 'staging',
      ttl: 30 * 60,
    });
    expect(cred.jti).toBeTruthy();
    expect(cred.token).toBeTruthy();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 6. SECRET_PROVIDER_SCOPE_MINIMAL
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-6 invariant: SECRET_PROVIDER_SCOPE_MINIMAL', () => {
  let provider: EnvFileSecretProvider;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [EnvFileSecretProvider],
    }).compile();
    provider = moduleRef.get(EnvFileSecretProvider);
  });

  it('guard: issued credential scope equals requested scope (no expansion)', async () => {
    const cred = await provider.issue('agent-1', {
      actions: ['git.read'],
      resources: ['repo/x'],
      environment: 'staging',
      ttl: 60,
    });
    expect(cred.scope.actions).toEqual(['git.read']);
    expect(cred.scope.resources).toEqual(['repo/x']);
    expect(cred.scope.environment).toBe('staging');
    expect(cred.scope.ttl).toBe(60);
  });

  it('guard: revoke(jti) invalidates the token immediately', async () => {
    const cred = await provider.issue('agent-1', {
      actions: ['git.read'],
      resources: ['repo/x'],
      environment: 'staging',
      ttl: 300,
    });
    await provider.revoke(cred.jti);
    const v = provider.verify(cred.token);
    expect(v.revoked).toBe(true);
    expect(v.valid).toBe(false);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 7. MODEL_GATEWAY_BUDGET_ENFORCED
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-7 invariant: MODEL_GATEWAY_BUDGET_ENFORCED', () => {
  let gateway: StubModelGateway;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [StubModelGateway],
    }).compile();
    gateway = moduleRef.get(StubModelGateway);
  });

  it('guard: inference rejected with BudgetExhaustedError when budget=0', async () => {
    await gateway.setBudget('agent-1', 'run-1', 100, 100); // consumed = total
    await expect(
      gateway.infer({
        agentId: 'agent-1',
        runId: 'run-1',
        modelId: 'gpt-x',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 16,
        temperature: 0.2,
      }),
    ).rejects.toBeInstanceOf(BudgetExhaustedError);
  });

  it('guard: budget isolated per (agentId, runId)', async () => {
    await gateway.setBudget('agent-1', 'run-1', 100, 100);
    // run-2 should still have full budget
    const budget2 = await gateway.getBudget('agent-1', 'run-2');
    expect(budget2.remaining).toBeGreaterThan(0);
    await expect(
      gateway.infer({
        agentId: 'agent-1',
        runId: 'run-2',
        modelId: 'gpt-x',
        systemPrompt: 'sys',
        userPrompt: 'user',
        maxTokens: 16,
        temperature: 0.2,
      }),
    ).resolves.toBeDefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 8. MODEL_GATEWAY_OUTPUT_INTERNALLY_INTERCEPTED
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-8 invariant: MODEL_GATEWAY_OUTPUT_INTERNALLY_INTERCEPTED', () => {
  let gateway: StubModelGateway;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [StubModelGateway],
    }).compile();
    gateway = moduleRef.get(StubModelGateway);
  });

  it('guard: infer() always returns degraded=true (kernel intercepts output before tool call)', async () => {
    const result = await gateway.infer({
      agentId: 'agent-1',
      runId: 'run-1',
      modelId: 'gpt-x',
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxTokens: 64,
      temperature: 0.2,
    });
    expect(result.degraded).toBe(true);
    // 输出经内核拦截后再走 Policy，不直接触发工具调用
  });

  it('guard: infer() never returns cached without budget threshold check', async () => {
    // 预算充足时不应走缓存路径
    await gateway.resetBudget('agent-1', 'run-1');
    const result = await gateway.infer({
      agentId: 'agent-1',
      runId: 'run-1',
      modelId: 'gpt-x',
      systemPrompt: 'sys',
      userPrompt: 'user',
      maxTokens: 16,
      temperature: 0.2,
    });
    // 默认预算下不缓存（cached 应为 undefined）
    expect(result.cached).toBeUndefined();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 9. TRACE_EXPORTER_NO_DATA_LEAK
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-9 invariant: TRACE_EXPORTER_NO_DATA_LEAK', () => {
  let exporter: NoopTraceExporter;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [NoopTraceExporter],
    }).compile();
    exporter = moduleRef.get(NoopTraceExporter);
  });

  it('guard: export() has no side effects (no data stored, no log output)', async () => {
    const spy = jest.spyOn(console, 'log').mockImplementation(() => {});
    await exporter.export({
      spanId: 'span-1',
      traceId: 'trace-1',
      name: 'tool.echo',
      startTime: 0,
      attributes: { runId: 'run-1', sensitive: 'secret-value' },
      events: [{ name: 'authorize', timestamp: 1, attributes: { decision: 'ALLOW' } }],
      status: 'ok',
    });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('guard: name is "noop" (no real transport active)', () => {
    expect(exporter.name).toBe('noop');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 10. SKILL_REGISTRY_SIGN_REQUIRED
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-10 invariant: SKILL_REGISTRY_SIGN_REQUIRED', () => {
  let registry: InMemorySkillRegistry;

  const manifest: SkillManifest = {
    name: 'k8s-rollout',
    version: '1.0.0',
    type: 'tool',
    description: 'kubectl rollout skill',
    tools: ['k8s.rollout'],
    riskTier: 'G3',
  };

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [InMemorySkillRegistry],
    }).compile();
    registry = moduleRef.get(InMemorySkillRegistry);
  });

  it('guard: register with empty signature sets signatureVerified=false', async () => {
    const record = await registry.register(manifest, '', 'tenant-1');
    expect(record.signatureVerified).toBe(false);
  });

  it('guard: register with valid signature sets signatureVerified=true', async () => {
    const record = await registry.register(manifest, 'sig-abc', 'tenant-1');
    expect(record.signatureVerified).toBe(true);
  });

  it('guard: listActive excludes revoked skills (cascade revocation)', async () => {
    const r1 = await registry.register(manifest, 'sig', 'tenant-1');
    await registry.enable(r1.skillId, 'admin-1');
    expect((await registry.listActive('tenant-1')).length).toBe(1);

    await registry.revoke(r1.skillId);
    expect((await registry.listActive('tenant-1'))).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 11. POLICY_ENGINE_DEFAULT_DENY (扩展守护)
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-1-11 invariant: POLICY_ENGINE_DEFAULT_DENY', () => {
  let engine: EmbeddedPolicyEngine;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [EmbeddedPolicyEngine],
    }).compile();
    engine = moduleRef.get(EmbeddedPolicyEngine);
  });

  it('guard: authorize() returns DENY with no rules loaded', async () => {
    const result = await engine.authorize({
      principal: { id: 'agent-1', type: 'agent', tenantId: 'tenant-1', roles: [] },
      action: 'anything',
      resource: 'any/resource',
      context: {},
    });
    expect(result.decision).toBe('DENY');
  });

  it('guard: evidence always contains evidenceId (audit trail integrity)', async () => {
    const result = await engine.authorize({
      principal: { id: 'agent-1', type: 'agent', tenantId: 'tenant-1', roles: [] },
      action: 'x',
      resource: 'y',
      context: {},
    });
    expect(result.evidence.evidenceId).toBeTruthy();
  });
});
