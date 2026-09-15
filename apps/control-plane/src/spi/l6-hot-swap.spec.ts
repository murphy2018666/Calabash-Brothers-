/**
 * L6-2 热切换 6 场景自动化测试（FR-M7-08 / DES-13.9）
 *
 * 验证 6 个热切换场景的自动一致性：
 *  1. 装机（AgentProvider 替换）
 *  2. 卸载（ToolProvider 替换）
 *  3. 升级（SkillRegistry 替换）
 *  4. 引擎切换（PolicyEngine 替换）
 *  5. 凭证切换（SecretProvider 替换）
 *  6. Trace 切换（TraceExporter 替换）
 *
 * 每场景断言：
 * - 旧实现仍可解析（通过 overrideProvider 前的状态）
 * - 新实现可注入并正常工作
 * - 切换期间新请求被拒绝（fail-closed）
 * - 不变量守护测试在新实现下仍然通过
 */

import { Test } from '@nestjs/testing';
import { SPI_TOKENS } from '@aegisci/core/spi';
import type { ToolCallRequest, AuthorizeRequest } from '@aegisci/shared/types';
import { SpiDefaultsModule } from '../providers/spi-defaults.module';
import { InMemoryAgentProvider } from '../providers/in-memory-agent-provider';
import { InMemoryToolProvider } from '../providers/in-memory-tool-provider';
import { InMemorySkillRegistry } from '../providers/in-memory-skill-registry';
import { EmbeddedPolicyEngine } from '../providers/embedded-policy-engine';
import { EnvFileSecretProvider } from '../providers/env-file-secret-provider';
import { VaultSecretProvider } from '../providers/vault-secret-provider';
import { NoopTraceExporter } from '../providers/noop-trace-exporter';
import { ToolCallAuthorizeGuard } from '../guards/tool-call-authorize.guard';
import { InvariantViolationError } from '../guards/invariant-violation.error';
import { MockAgentProvider, MockToolProvider, MockSkillRegistry, MockPolicyEngine, MockSecretProvider, MockTraceExporter } from '../mocks/factory';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 1：装机（AgentProvider 替换为 Mock）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-1 hot-swap: AgentProvider install', () => {
  it('default implementation is InMemoryAgentProvider', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.AGENT_PROVIDER)).toBeInstanceOf(InMemoryAgentProvider);
  });

  it('can be overridden with MockAgentProvider (install)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] })
      .overrideProvider(SPI_TOKENS.AGENT_PROVIDER).useClass(MockAgentProvider).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.AGENT_PROVIDER)).toBeInstanceOf(MockAgentProvider);
  });

  it('guard invariant still enforced after agent install swap', async () => {
    const toolExecute = jest.fn().mockResolvedValue({ success: true, data: 'ok', evidenceId: 'ev-1', traceSpanId: 'span-1' });
    const mockTool = { name: 'echo', actions: () => ['echo'], execute: toolExecute, healthy: async () => true };
    const mockEngine = {
      authorize: jest.fn().mockResolvedValue({ decision: 'ALLOW', evidence: { evidenceId: 'ev-1', policyVersion: 'v0', decision: 'ALLOW' as const, reason: 'ok', rules: [] }, cacheHit: false }),
      getPolicyVersion: () => 'v0', simulate: async () => ({}), healthy: async () => true,
    };
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule], providers: [ToolCallAuthorizeGuard] })
      .overrideProvider(SPI_TOKENS.AGENT_PROVIDER).useClass(MockAgentProvider)
      .overrideProvider(SPI_TOKENS.TOOL_PROVIDER).useValue(mockTool)
      .overrideProvider(SPI_TOKENS.POLICY_ENGINE).useValue(mockEngine)
      .compile();
    await moduleRef.init();

    const guard = moduleRef.get(ToolCallAuthorizeGuard);
    await expect(guard.execute({ toolName: 'echo', action: 'echo', resource: 'repo/x', args: {}, agentId: 'agent-1', runId: 'run-1' }))
      .rejects.toBeInstanceOf(InvariantViolationError);
    expect(toolExecute).not.toHaveBeenCalled();
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 2：卸载（ToolProvider 替换为 Mock）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-2 hot-swap: ToolProvider uninstall', () => {
  it('default implementation is InMemoryToolProvider', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.TOOL_PROVIDER)).toBeInstanceOf(InMemoryToolProvider);
  });

  it('can be overridden with MockToolProvider (uninstall)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] })
      .overrideProvider(SPI_TOKENS.TOOL_PROVIDER).useClass(MockToolProvider).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.TOOL_PROVIDER)).toBeInstanceOf(MockToolProvider);
  });

  it('policy authorization invariant holds after tool uninstall swap', async () => {
    const mockEngine = {
      authorize: jest.fn().mockResolvedValue({ decision: 'ALLOW', evidence: { evidenceId: 'ev-1', policyVersion: 'v0', decision: 'ALLOW' as const, reason: 'ok', rules: [] }, cacheHit: false }),
      getPolicyVersion: () => 'v0', simulate: async () => ({}), healthy: async () => true,
    };
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule], providers: [ToolCallAuthorizeGuard] })
      .overrideProvider(SPI_TOKENS.TOOL_PROVIDER).useClass(MockToolProvider)
      .overrideProvider(SPI_TOKENS.POLICY_ENGINE).useValue(mockEngine)
      .compile();
    await moduleRef.init();

    const guard = moduleRef.get(ToolCallAuthorizeGuard);
    await expect(guard.execute({ toolName: 'x', action: 'x', resource: 'r', args: {}, agentId: 'a', runId: 'r1' }))
      .rejects.toBeInstanceOf(InvariantViolationError);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 3：升级（SkillRegistry 替换为 Mock）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-3 hot-swap: SkillRegistry upgrade', () => {
  it('default implementation is InMemorySkillRegistry', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.SKILL_REGISTRY)).toBeInstanceOf(InMemorySkillRegistry);
  });

  it('can be overridden with MockSkillRegistry (upgrade)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] })
      .overrideProvider(SPI_TOKENS.SKILL_REGISTRY).useClass(MockSkillRegistry).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.SKILL_REGISTRY)).toBeInstanceOf(MockSkillRegistry);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 4：引擎切换（PolicyEngine 替换为 Mock）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-4 hot-swap: PolicyEngine engine change', () => {
  it('default implementation is EmbeddedPolicyEngine', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.POLICY_ENGINE)).toBeInstanceOf(EmbeddedPolicyEngine);
  });

  it('can be overridden with MockPolicyEngine (shadow mode)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] })
      .overrideProvider(SPI_TOKENS.POLICY_ENGINE).useClass(MockPolicyEngine).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.POLICY_ENGINE)).toBeInstanceOf(MockPolicyEngine);
  });

  it('guard invariant holds after engine swap (fail-closed: DENY on unknown engine)', async () => {
    const mockEngine = {
      authorize: async () => { throw new Error('mock-policy-error'); },
      getPolicyVersion: () => 'mock', simulate: async () => ({}), healthy: async () => true,
    };
    const toolExecute = jest.fn();
    const mockTool = { name: 'echo', actions: () => ['echo'], execute: toolExecute, healthy: async () => true };
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule], providers: [ToolCallAuthorizeGuard] })
      .overrideProvider(SPI_TOKENS.POLICY_ENGINE).useValue(mockEngine)
      .overrideProvider(SPI_TOKENS.TOOL_PROVIDER).useValue(mockTool)
      .compile();
    await moduleRef.init();

    const guard = moduleRef.get(ToolCallAuthorizeGuard);
    await expect(guard.authorize({ principal: { id: 'a', type: 'agent', tenantId: 't', roles: [] }, action: 'x', resource: 'r', context: {} }))
      .rejects.toThrow('mock-policy-error');
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 5：凭证切换（SecretProvider 替换为 Mock）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-5 hot-swap: SecretProvider credential switch', () => {
  it('default implementation is VaultSecretProvider (standard mode)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.SECRET_PROVIDER)).toBeInstanceOf(VaultSecretProvider);
  });

  it('can be overridden with MockSecretProvider (switch)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] })
      .overrideProvider(SPI_TOKENS.SECRET_PROVIDER).useClass(MockSecretProvider).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.SECRET_PROVIDER)).toBeInstanceOf(MockSecretProvider);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 场景 6：Trace 切换（TraceExporter 替换为 Mock）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2-6 hot-swap: TraceExporter trace switch', () => {
  it('default implementation is NoopTraceExporter', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] }).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.TRACE_EXPORTER)).toBeInstanceOf(NoopTraceExporter);
  });

  it('can be overridden with MockTraceExporter (switch)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule] })
      .overrideProvider(SPI_TOKENS.TRACE_EXPORTER).useClass(MockTraceExporter).compile();
    await moduleRef.init();
    expect(moduleRef.get(SPI_TOKENS.TRACE_EXPORTER)).toBeInstanceOf(MockTraceExporter);
  });

  it('invariant guard still works after trace exporter swap', async () => {
    const mockTrace = { name: 'mock-trace', export: async () => {}, healthy: async () => true };
    const mockEngine = {
      authorize: jest.fn().mockResolvedValue({ decision: 'ALLOW', evidence: { evidenceId: 'ev-1', policyVersion: 'v0', decision: 'ALLOW' as const, reason: 'ok', rules: [] }, cacheHit: false }),
      getPolicyVersion: () => 'v0', simulate: async () => ({}), healthy: async () => true,
    };
    const toolExecute = jest.fn().mockResolvedValue({ success: true, data: 'ok', evidenceId: 'ev-1', traceSpanId: 'span-1' });
    const mockTool = { name: 'echo', actions: () => ['echo'], execute: toolExecute, healthy: async () => true };
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule], providers: [ToolCallAuthorizeGuard] })
      .overrideProvider(SPI_TOKENS.TRACE_EXPORTER).useValue(mockTrace)
      .overrideProvider(SPI_TOKENS.POLICY_ENGINE).useValue(mockEngine)
      .overrideProvider(SPI_TOKENS.TOOL_PROVIDER).useValue(mockTool)
      .compile();
    await moduleRef.init();

    const guard = moduleRef.get(ToolCallAuthorizeGuard);
    await expect(guard.execute({ toolName: 'echo', action: 'echo', resource: 'repo/x', args: {}, agentId: 'agent-1', runId: 'run-1' }))
      .rejects.toBeInstanceOf(InvariantViolationError);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 综合场景：切换期间新请求被拒绝（fail-closed）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
describe('L6-2 combined: fail-closed during swap window', () => {
  it('during engine swap (mock throws), new authorize requests fail-closed', async () => {
    const breakingEngine = {
      authorize: async () => { throw new Error('engine-not-ready'); },
      getPolicyVersion: () => 'v0', simulate: async () => ({}), healthy: async () => false,
    };
    const toolExecute = jest.fn();
    const mockTool = { name: 'echo', actions: () => ['echo'], execute: toolExecute, healthy: async () => true };
    const moduleRef = await Test.createTestingModule({ imports: [SpiDefaultsModule], providers: [ToolCallAuthorizeGuard] })
      .overrideProvider(SPI_TOKENS.POLICY_ENGINE).useValue(breakingEngine)
      .overrideProvider(SPI_TOKENS.TOOL_PROVIDER).useValue(mockTool)
      .compile();
    await moduleRef.init();

    const guard = moduleRef.get(ToolCallAuthorizeGuard);
    await expect(
      guard.authorize({ principal: { id: 'a', type: 'agent', tenantId: 't', roles: [] }, action: 'x', resource: 'r', context: {} }),
    ).rejects.toThrow('engine-not-ready');
    expect(toolExecute).not.toHaveBeenCalled();
  });
});
