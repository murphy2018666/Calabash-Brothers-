/**
 * Mock Factory 单元测试（S31-MOCK-2）
 *
 * 覆盖：7 个 SPI mock 类的接口实现与行为验证
 */
import { MockTraceExporter, MockSecretProvider, MockPolicyEngine, MockAgentProvider, MockToolProvider, MockSkillRegistry, MockModelGateway, MockSpiFactory } from './factory';
import { SPI_TOKENS } from '@aegisci/core/spi';

describe('Mock Factory (S31-MOCK-2)', () => {
  // ── MockTraceExporter ──

  describe('MockTraceExporter', () => {
    it('exports span and records it', async () => {
      const exporter = new MockTraceExporter();
      await exporter.export({ spanId: 's1', traceId: 't1', name: 'test', startTime: 0, attributes: {}, events: [], status: 'ok' } as any);
      expect(exporter.getSpans()).toHaveLength(1);
    });

    it('healthy returns true', async () => {
      const exporter = new MockTraceExporter();
      expect(await exporter.healthy()).toBe(true);
    });
  });

  // ── MockSecretProvider ──

  describe('MockSecretProvider', () => {
    it('issues credential with correct structure', async () => {
      const provider = new MockSecretProvider();
      const cred = await provider.issue('user-1', { actions: ['read'], resources: ['*'], environment: 'test', ttl: 60 });
      expect(cred.token).toContain('user-1');
      expect(cred.jti).toBeTruthy();
    });

    it('revokes by jti', async () => {
      const provider = new MockSecretProvider();
      const cred = await provider.issue('user-1', { actions: [], resources: [], environment: 'test', ttl: 60 });
      await provider.revoke(cred.jti);
      expect(provider['store'].has(cred.jti)).toBe(false);
    });

    it('healthy returns true', async () => {
      const provider = new MockSecretProvider();
      expect(await provider.healthy()).toBe(true);
    });
  });

  // ── MockPolicyEngine ──

  describe('MockPolicyEngine', () => {
    it('returns configured authorize result', async () => {
      const engine = new MockPolicyEngine();
      engine.setAuthorizeResult({ decision: 'deny', evidenceId: 'e1' });
      const result = await engine.authorize({} as any);
      expect(result.decision).toBe('deny');
    });

    it('getPolicyVersion returns configured version', () => {
      const engine = new MockPolicyEngine();
      engine.setVersion('v2');
      expect(engine.getPolicyVersion()).toBe('v2');
    });

    it('healthy returns true', async () => {
      const engine = new MockPolicyEngine();
      expect(await engine.healthy()).toBe(true);
    });
  });

  // ── MockAgentProvider ──

  describe('MockAgentProvider', () => {
    it('registers and retrieves agent card', async () => {
      const provider = new MockAgentProvider();
      const card = { agentId: 'a1', role: 'reviewer' as any, displayName: 'R', modelId: 'm', capabilities: [], riskTier: 'G1', tenantId: 't1' };
      await provider.register(card);
      const retrieved = await provider.getCard('a1');
      expect(retrieved?.agentId).toBe('a1');
    });

    it('healthy returns true', async () => {
      const provider = new MockAgentProvider();
      expect(await provider.healthy()).toBe(true);
    });
  });

  // ── MockToolProvider ──

  describe('MockToolProvider', () => {
    it('returns configured actions', () => {
      const provider = new MockToolProvider();
      provider.setActions(['action-a', 'action-b']);
      expect(provider.actions()).toEqual(['action-a', 'action-b']);
    });

    it('execute uses custom impl', async () => {
      const provider = new MockToolProvider();
      provider.setExecute(async () => ({ data: 'custom-result' }));
      const result = await provider.execute({});
      expect(result.data).toBe('custom-result');
    });

    it('healthy returns true', async () => {
      const provider = new MockToolProvider();
      expect(await provider.healthy()).toBe(true);
    });
  });

  // ── MockSkillRegistry ──

  describe('MockSkillRegistry', () => {
    it('registers and retrieves skill', async () => {
      const registry = new MockSkillRegistry();
      const record = await registry.register({ name: 's1' } as any, 'sig', 't1');
      expect(record.skillId).toBeTruthy();
      expect(record.tenantId).toBe('t1');
    });

    it('listActive filters by tenant', async () => {
      const registry = new MockSkillRegistry();
      await registry.register({ name: 's1', version: '1.0', type: 'tool' as any, description: '', riskTier: 'G1' as any }, 'sig', 't-a');
      await registry.register({ name: 's2', version: '1.0', type: 'tool' as any, description: '', riskTier: 'G1' as any }, 'sig', 't-b');
      const all = await registry.listActive('t-a');
      expect(all.length).toBe(1);
    });

    it('healthy returns true', async () => {
      const registry = new MockSkillRegistry();
      expect(await registry.healthy()).toBe(true);
    });
  });

  // ── MockModelGateway ──

  describe('MockModelGateway', () => {
    it('returns default inference result', async () => {
      const gateway = new MockModelGateway();
      const result = await gateway.infer({ agentId: 'a1', runId: 'r1', modelId: 'gpt-4', systemPrompt: '', userPrompt: 'hi', maxTokens: 100, temperature: 0.7 } as any);
      expect(result.content).toContain('[mock]');
    });

    it('supports custom infer impl', async () => {
      const gateway = new MockModelGateway();
      gateway.setInfer(async () => ({ content: 'custom', inputTokens: 0, outputTokens: 0, modelId: 'x', degraded: false, traceSpanId: 's' }));
      const result = await gateway.infer({ agentId: 'a1', runId: 'r1', modelId: 'm', systemPrompt: '', userPrompt: '', maxTokens: 10, temperature: 0 } as any);
      expect(result.content).toBe('custom');
    });

    it('getBudget initializes with defaults', async () => {
      const gateway = new MockModelGateway();
      const budget = await gateway.getBudget('a1', 'r1');
      expect(budget.totalBudget).toBe(8000);
      expect(budget.remaining).toBe(8000);
    });

    it('setBudget updates budget', async () => {
      const gateway = new MockModelGateway();
      await gateway.setBudget('a1', 'r1', 1000, 200);
      const budget = await gateway.getBudget('a1', 'r1');
      expect(budget.remaining).toBe(800);
    });

    it('healthy returns true', async () => {
      const gateway = new MockModelGateway();
      expect(await gateway.healthy()).toBe(true);
    });
  });

  // ── MockSpiFactory ──

  describe('MockSpiFactory.create()', () => {
    it('returns all 7 mock instances', () => {
      const mocks = MockSpiFactory.create();
      expect(mocks.traceExporter).toBeInstanceOf(MockTraceExporter);
      expect(mocks.secretProvider).toBeInstanceOf(MockSecretProvider);
      expect(mocks.policyEngine).toBeInstanceOf(MockPolicyEngine);
      expect(mocks.agentProvider).toBeInstanceOf(MockAgentProvider);
      expect(mocks.toolProvider).toBeInstanceOf(MockToolProvider);
      expect(mocks.skillRegistry).toBeInstanceOf(MockSkillRegistry);
      expect(mocks.modelGateway).toBeInstanceOf(MockModelGateway);
    });

    it('can be used with overrideProvider pattern', async () => {
      const { Test } = await import('@nestjs/testing');
      const mocks = MockSpiFactory.create();

      // Verify each mock instance can be retrieved when overridden
      const moduleRef = await Test.createTestingModule({
        providers: [
          { provide: SPI_TOKENS.TRACE_EXPORTER, useValue: mocks.traceExporter },
          { provide: SPI_TOKENS.POLICY_ENGINE, useValue: mocks.policyEngine },
          { provide: SPI_TOKENS.AGENT_PROVIDER, useValue: mocks.agentProvider },
        ],
      }).compile();

      expect(moduleRef.get(SPI_TOKENS.TRACE_EXPORTER)).toBe(mocks.traceExporter);
      expect(moduleRef.get(SPI_TOKENS.POLICY_ENGINE)).toBe(mocks.policyEngine);
      expect(moduleRef.get(SPI_TOKENS.AGENT_PROVIDER)).toBe(mocks.agentProvider);
    });
  });
});
