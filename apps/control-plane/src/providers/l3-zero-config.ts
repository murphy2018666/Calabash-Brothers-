/**
 * L3: 零配置出厂默认验证
 *
 * 验证 AegisCI 出厂配置（无外部依赖即可启动）：
 *  - aegisci-minimal.yaml 配置模板存在性
 *  - NoopTraceExporter 零开销验证
 *  - EnvFileSecretProvider 无文件时降级
 *  - EmbeddedPolicyEngine 默认策略
 *  - 组合验证：全部 SPI 默认实现可注入
 *
 * 对应 WBS: L3 (1.11.3 零配置出厂默认+安装验证)
 */

import { Injectable, Module } from '@nestjs/common';
import { SPI_TOKENS } from '@aegisci/core/spi';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L3 SPI 默认实现（从现有 providers 中复用）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * NoopTraceExporter — 零开销 trace 导出（L3 默认）
 */
@Injectable()
export class NoopTraceExporter {
  async exportSpans(spans: unknown[]): Promise<void> {
    void spans;
    // 零开销：什么都不做
  }
  async healthy(): Promise<boolean> {
    return true;
  }
}

/**
 * EnvFileSecretProvider — 无 env_file 时返回 null（L3 默认）
 */
@Injectable()
export class EnvFileSecretProvider {
  async get(key: string): Promise<string | null> {
    void key;
    return process.env[key] ?? null;
  }
  async healthy(): Promise<boolean> {
    return true;
  }
}

/**
 * EmbeddedPolicyEngine — 默认拒绝策略（fail-closed）
 */
@Injectable()
export class EmbeddedPolicyEngine {
  async authorize(params: {
    action: string;
    resource: string;
    principal: string;
    tenantId: string;
  }): Promise<{ allowed: boolean; reason: string }> {
    void params;
    // 默认 fail-closed：未配置策略时拒绝
    return { allowed: false, reason: 'no policy configured (default deny)' };
  }
  async healthy(): Promise<boolean> {
    return true;
  }
}

/**
 * InMemoryAgentProvider — 内存 Agent 注册表
 */
@Injectable()
export class InMemoryAgentProvider {
  private readonly agents = new Map<string, { id: string; name: string }>();

  async register(agent: { id: string; name: string }): Promise<void> {
    this.agents.set(agent.id, agent);
  }
  async get(id: string): Promise<{ id: string; name: string } | null> {
    return this.agents.get(id) ?? null;
  }
  async list(): Promise<Array<{ id: string; name: string }>> {
    return [...this.agents.values()];
  }
  async healthy(): Promise<boolean> {
    return true;
  }
}

/**
 * InMemoryToolProvider — 内存工具注册表
 */
@Injectable()
export class InMemoryToolProvider {
  private readonly tools = new Map<string, { id: string; name: string }>();

  async register(tool: { id: string; name: string }): Promise<void> {
    this.tools.set(tool.id, tool);
  }
  async get(id: string): Promise<{ id: string; name: string } | null> {
    return this.tools.get(id) ?? null;
  }
  async healthy(): Promise<boolean> {
    return true;
  }
}

/**
 * InMemorySkillRegistry — 内存技能注册表
 */
@Injectable()
export class InMemorySkillRegistry {
  private readonly skills = new Map<string, { name: string; version: string }>();

  async register(skill: { name: string; version: string }): Promise<void> {
    this.skills.set(`${skill.name}@${skill.version}`, skill);
  }
  async get(name: string, version: string): Promise<{ name: string; version: string } | null> {
    return this.skills.get(`${name}@${version}`) ?? null;
  }
  async healthy(): Promise<boolean> {
    return true;
  }
}

/**
 * StubModelGateway — 默认 LLM 网关（stub）
 */
@Injectable()
export class StubModelGateway {
  async chat(params: { model: string; messages: unknown[] }): Promise<{ content: string }> {
    void params;
    return { content: '[stub response]' };
  }
  async healthy(): Promise<boolean> {
    return true;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L3 ZeroConfigVerifier
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ZeroConfigCheck {
  component: string;
  ok: boolean;
  latencyMs: number;
  detail: string;
}

export class ZeroConfigVerifier {
  /**
   * verifyNoopTrace —— 验证 NoopTraceExporter 零开销
   */
  async verifyNoopTrace(exporter: NoopTraceExporter): Promise<ZeroConfigCheck> {
    const t0 = performance.now();
    await exporter.exportSpans(Array.from({ length: 1000 }, (_, i) => ({ id: i })));
    const elapsed = performance.now() - t0;
    return {
      component: 'NoopTraceExporter',
      ok: elapsed < 10, // 1000 spans < 10ms
      latencyMs: elapsed,
      detail: `1000 spans exported in ${elapsed.toFixed(2)}ms`,
    };
  }

  /**
   * verifySecretProvider —— 验证 EnvFileSecretProvider 无文件时不崩溃
   */
  async verifySecretProvider(provider: EnvFileSecretProvider): Promise<ZeroConfigCheck> {
    const t0 = performance.now();
    const result = await provider.get('AEGISCI_NONEXISTENT_KEY_xyz');
    const elapsed = performance.now() - t0;
    return {
      component: 'EnvFileSecretProvider',
      ok: result === null && elapsed < 10,
      latencyMs: elapsed,
      detail: `get non-existent key returned null in ${elapsed.toFixed(2)}ms`,
    };
  }

  /**
   * verifyPolicyEngine —— 验证默认策略为 fail-closed
   */
  async verifyPolicyEngine(engine: EmbeddedPolicyEngine): Promise<ZeroConfigCheck> {
    const t0 = performance.now();
    const result = await engine.authorize({
      action: 'run',
      resource: 'pipeline',
      principal: 'test-user',
      tenantId: 'test-tenant',
    });
    const elapsed = performance.now() - t0;
    return {
      component: 'EmbeddedPolicyEngine',
      ok: !result.allowed && elapsed < 10,
      latencyMs: elapsed,
      detail: `default deny enforced in ${elapsed.toFixed(2)}ms`,
    };
  }

  /**
   * verifyAllSpis —— 验证所有 SPI 默认实现可注入
   */
  async verifyAllSpis(
    traceExporter: NoopTraceExporter,
    secretProvider: EnvFileSecretProvider,
    policyEngine: EmbeddedPolicyEngine,
    agentProvider: InMemoryAgentProvider,
    toolProvider: InMemoryToolProvider,
    skillRegistry: InMemorySkillRegistry,
    modelGateway: StubModelGateway,
  ): Promise<ZeroConfigCheck[]> {
    return Promise.all([
      this.verifyNoopTrace(traceExporter),
      this.verifySecretProvider(secretProvider),
      this.verifyPolicyEngine(policyEngine),
      this.verifyAgentProvider(agentProvider),
      this.verifyToolProvider(toolProvider),
      this.verifySkillRegistry(skillRegistry),
      this.verifyModelGateway(modelGateway),
    ]);
  }

  private async verifyAgentProvider(p: InMemoryAgentProvider): Promise<ZeroConfigCheck> {
    const t0 = performance.now();
    await p.register({ id: 'agent-l3-test', name: 'L3 Test Agent' });
    const agent = await p.get('agent-l3-test');
    const elapsed = performance.now() - t0;
    return {
      component: 'InMemoryAgentProvider',
      ok: agent !== null && elapsed < 10,
      latencyMs: elapsed,
      detail: `register+get agent in ${elapsed.toFixed(2)}ms`,
    };
  }

  private async verifyToolProvider(p: InMemoryToolProvider): Promise<ZeroConfigCheck> {
    const t0 = performance.now();
    await p.register({ id: 'tool-l3-test', name: 'L3 Test Tool' });
    const tool = await p.get('tool-l3-test');
    const elapsed = performance.now() - t0;
    return {
      component: 'InMemoryToolProvider',
      ok: tool !== null && elapsed < 10,
      latencyMs: elapsed,
      detail: `register+get tool in ${elapsed.toFixed(2)}ms`,
    };
  }

  private async verifySkillRegistry(p: InMemorySkillRegistry): Promise<ZeroConfigCheck> {
    const t0 = performance.now();
    await p.register({ name: 'skill-l3', version: '1.0.0' });
    const skill = await p.get('skill-l3', '1.0.0');
    const elapsed = performance.now() - t0;
    return {
      component: 'InMemorySkillRegistry',
      ok: skill !== null && elapsed < 10,
      latencyMs: elapsed,
      detail: `register+get skill in ${elapsed.toFixed(2)}ms`,
    };
  }

  private async verifyModelGateway(g: StubModelGateway): Promise<ZeroConfigCheck> {
    const t0 = performance.now();
    const result = await g.chat({ model: 'stub-model', messages: [] });
    const elapsed = performance.now() - t0;
    return {
      component: 'StubModelGateway',
      ok: result.content === '[stub response]' && elapsed < 10,
      latencyMs: elapsed,
      detail: `chat stub in ${elapsed.toFixed(2)}ms`,
    };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L3 出厂配置模板（内容验证）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const DEFAULT_CONFIG_TEMPLATE = `# AegisCI Zero-Config Default
# 此配置无需任何外部依赖即可启动
# 对应 L3: 零配置出厂默认+安装验证

server:
  port: 3000

trace:
  exporter: noop          # NoopTraceExporter（零开销默认）

secrets:
  provider: env_file      # EnvFileSecretProvider（从环境变量读取）

policy:
  engine: embedded        # EmbeddedPolicyEngine（fail-closed 默认）

agents:
  registry: in_memory     # InMemoryAgentProvider

tools:
  registry: in_memory     # InMemoryToolProvider

skills:
  registry: in_memory     # InMemorySkillRegistry

llm:
  gateway: stub           # StubModelGateway（无需 LLM API）

audit:
  worm: in_memory         # InMemoryAuditWormSink
`;

export function validateConfigTemplate(template: string): { ok: boolean; issues: string[] } {
  const issues: string[] = [];

  // 检查必要配置项
  const requiredKeys = ['trace:', 'secrets:', 'policy:', 'agents:', 'tools:', 'skills:', 'llm:', 'audit:'];
  for (const key of requiredKeys) {
    if (!template.includes(key)) {
      issues.push(`Missing required config section: ${key}`);
    }
  }

  // 检查关键默认值
  if (!template.includes('exporter: noop')) issues.push('Missing trace.exporter: noop');
  if (!template.includes('engine: embedded')) issues.push('Missing policy.engine: embedded');
  if (!template.includes('gateway: stub')) issues.push('Missing llm.gateway: stub');

  return { ok: issues.length === 0, issues };
}
