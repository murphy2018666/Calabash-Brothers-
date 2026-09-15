/**
 * Mock 模式工厂 — 提供 SPI 接口的全量 mock 实现
 *
 * 这些 mock 实现仅在 AEGISCI_MOCK_MODE 启用时（测试 / dev）生效。
 * 生产环境使用真实实现（StubModelGateway、NoopTraceExporter 等）。
 *
 * 用法：
 *   import { MockSpiFactory } from '../mocks/factory';
 *   const { traceExporter, secretProvider, ... } = MockSpiFactory.create();
 */

import type { TraceExporter } from '@aegisci/core/spi/trace';
import type { SecretProvider, CredentialScope, IssuedCredential } from '@aegisci/core/spi/secrets';
import type { PolicyEngineSPI, AuthorizeRequest, AuthorizeResult } from '@aegisci/core/spi/policy';
import type { AgentProvider, AgentCard, AgentRole } from '@aegisci/core/spi/agents';
import type { ToolProvider } from '@aegisci/core/spi/tools';
import type { SkillRegistrySPI, SkillRecord } from '@aegisci/core/spi/skills';
import type { ModelGateway, ModelInferenceRequest, ModelInferenceResult, ModelBudget } from '@aegisci/core/spi/models';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// TraceExporter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class MockTraceExporter implements TraceExporter {
  readonly name = 'mock-trace';
  private readonly spans: Array<{ span: any; exportedAt: number }> = [];

  async export(span: any): Promise<void> {
    this.spans.push({ span, exportedAt: Date.now() });
  }

  async healthy(): Promise<boolean> { return true; }

  getSpans(): typeof this.spans { return [...this.spans]; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SecretProvider
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class MockSecretProvider implements SecretProvider {
  private readonly store = new Map<string, IssuedCredential>();

  async issue(principal: string, scope: CredentialScope): Promise<IssuedCredential> {
    const credential: IssuedCredential = {
      credentialId: `cred-${Date.now()}`,
      token: `mock-token-${principal}`,
      scope,
      expiresAt: new Date(Date.now() + scope.ttl * 1000).toISOString(),
      jti: `jti-${Date.now()}`,
    };
    this.store.set(credential.jti, credential);
    return credential;
  }

  async revoke(jti: string): Promise<void> {
    this.store.delete(jti);
  }

  async revokeAll(principal: string): Promise<string[]> {
    const removed: string[] = [];
    for (const [jti, cred] of this.store) {
      if (cred.token.includes(principal)) {
        this.store.delete(jti);
        removed.push(jti);
      }
    }
    return removed;
  }

  async healthy(): Promise<boolean> { return true; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// PolicyEngineSPI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class MockPolicyEngine implements PolicyEngineSPI {
  private _version = 'mock-v1';
  private _authorizeResult: AuthorizeResult = { decision: 'allow', evidenceId: 'mock-evidence' };

  setAuthorizeResult(result: AuthorizeResult): void {
    this._authorizeResult = result;
  }

  setVersion(version: string): void {
    this._version = version;
  }

  async authorize(_req: AuthorizeRequest): Promise<AuthorizeResult> {
    return { ...this._authorizeResult };
  }

  getPolicyVersion(): string { return this._version; }

  async simulate(_req: AuthorizeRequest): Promise<AuthorizeResult> {
    return this.authorize(_req);
  }

  async healthy(): Promise<boolean> { return true; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// AgentProvider
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class MockAgentProvider implements AgentProvider {
  private readonly cards = new Map<string, AgentCard>();

  async register(card: AgentCard): Promise<void> {
    this.cards.set(card.agentId, card);
  }

  async getCard(agentId: string): Promise<AgentCard | null> {
    return this.cards.get(agentId) ?? null;
  }

  async listByRole(role: AgentRole, _tenantId: string): Promise<AgentCard[]> {
    return [...this.cards.values()].filter(c => c.role === role);
  }

  async deregister(agentId: string): Promise<void> {
    this.cards.delete(agentId);
  }

  async healthy(): Promise<boolean> { return true; }

  getSize(): number { return this.cards.size; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ToolProvider
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class MockToolProvider implements ToolProvider {
  readonly name = 'mock-tool';
  private readonly actions_: string[] = [];
  private executeImpl: (req: any) => Promise<any> = async () => ({ success: true, data: null });

  setActions(actions: string[]): void {
    this.actions_ = actions;
  }

  setExecute(fn: (req: any) => Promise<any>): void {
    this.executeImpl = fn;
  }

  actions(): string[] { return this.actions_; }

  async execute(req: any): Promise<any> {
    return this.executeImpl(req);
  }

  async healthy(): Promise<boolean> { return true; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SkillRegistrySPI
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class MockSkillRegistry implements SkillRegistrySPI {
  private readonly store = new Map<string, SkillRecord>();

  async register(_manifest: any, _signature: string, tenantId: string): Promise<SkillRecord> {
    const record: SkillRecord = {
      skillId: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      manifest: _manifest,
      state: 'active' as any,
      signatureVerified: true,
      installedAt: new Date().toISOString(),
      tenantId,
    };
    this.store.set(record.skillId, record);
    return record;
  }

  async get(skillId: string): Promise<SkillRecord | null> {
    return this.store.get(skillId) ?? null;
  }

  async listActive(tenantId: string): Promise<SkillRecord[]> {
    return [...this.store.values()].filter(r => r.tenantId === tenantId && r.state === 'active');
  }

  async enable(_skillId: string, _approvedBy: string): Promise<void> { /* no-op */ }
  async revoke(_skillId: string): Promise<void> { /* no-op */ }
  async healthy(): Promise<boolean> { return true; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// ModelGateway
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class MockModelGateway implements ModelGateway {
  private readonly budgets = new Map<string, ModelBudget>();
  private inferImpl: (req: ModelInferenceRequest) => Promise<ModelInferenceResult> =
    async (req) => ({
      content: `[mock] response for ${req.agentId}`,
      inputTokens: 10,
      outputTokens: 20,
      modelId: req.modelId,
      degraded: false,
      traceSpanId: `mock-span-${req.runId}`,
    });

  setInfer(fn: (req: ModelInferenceRequest) => Promise<ModelInferenceResult>): void {
    this.inferImpl = fn;
  }

  async infer(req: ModelInferenceRequest): Promise<ModelInferenceResult> {
    return this.inferImpl(req);
  }

  async getBudget(agentId: string, runId: string): Promise<ModelBudget> {
    const key = `${agentId}|${runId}`;
    let budget = this.budgets.get(key);
    if (!budget) {
      budget = { agentId, runId, totalBudget: 8000, consumed: 0, remaining: 8000 };
      this.budgets.set(key, budget);
    }
    return budget;
  }

  async setBudget(agentId: string, runId: string, total: number, consumed = 0): Promise<void> {
    this.budgets.set(`${agentId}|${runId}`, {
      agentId, runId, totalBudget: total, consumed,
      remaining: Math.max(0, total - consumed),
    });
  }

  async healthy(): Promise<boolean> { return true; }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Factory
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface MockSpiInstances {
  traceExporter: MockTraceExporter;
  secretProvider: MockSecretProvider;
  policyEngine: MockPolicyEngine;
  agentProvider: MockAgentProvider;
  toolProvider: MockToolProvider;
  skillRegistry: MockSkillRegistry;
  modelGateway: MockModelGateway;
}

export const MockSpiFactory = {
  /**
   * 创建完整的 SPI mock 实例集合。
   * 调用方负责通过 overrideProvider 注入到 NestJS 测试模块中。
   */
  create(): MockSpiInstances {
    return {
      traceExporter: new MockTraceExporter(),
      secretProvider: new MockSecretProvider(),
      policyEngine: new MockPolicyEngine(),
      agentProvider: new MockAgentProvider(),
      toolProvider: new MockToolProvider(),
      skillRegistry: new MockSkillRegistry(),
      modelGateway: new MockModelGateway(),
    };
  },
};
