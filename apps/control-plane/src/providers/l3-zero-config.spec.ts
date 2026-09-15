/**
 * L3: 零配置出厂默认验证 — 测试套件
 *
 * 覆盖：NoopTraceExporter 零开销、SecretProvider 降级、PolicyEngine fail-closed、
 *       全部 SPI 可注入、配置模板有效性
 */

import {
  NoopTraceExporter,
  EnvFileSecretProvider,
  EmbeddedPolicyEngine,
  InMemoryAgentProvider,
  InMemoryToolProvider,
  InMemorySkillRegistry,
  StubModelGateway,
  ZeroConfigVerifier,
  DEFAULT_CONFIG_TEMPLATE,
  validateConfigTemplate,
} from './l3-zero-config';

describe('L3: Zero-Config Factory Default Verification', () => {
  describe('NoopTraceExporter', () => {
    it('L3-1-1: exportSpans is near-zero overhead', async () => {
      const exporter = new NoopTraceExporter();
      const t0 = performance.now();
      await exporter.exportSpans(Array.from({ length: 1000 }, (_, i) => ({ spanId: `s-${i}` })));
      const elapsed = performance.now() - t0;
      expect(elapsed).toBeLessThan(10); // 1000 spans < 10ms
    });

    it('L3-1-2: healthy returns true', async () => {
      const exporter = new NoopTraceExporter();
      expect(await exporter.healthy()).toBe(true);
    });
  });

  describe('EnvFileSecretProvider', () => {
    it('L3-2-1: get non-existent key returns null (no crash)', async () => {
      const provider = new EnvFileSecretProvider();
      const result = await provider.get('AEGISCI_NONEXISTENT_L3_KEY');
      expect(result).toBeNull();
    });

    it('L3-2-2: get existing env var returns value', async () => {
      process.env['AEGISCI_L3_TEST_VAR'] = 'test-value';
      const provider = new EnvFileSecretProvider();
      const result = await provider.get('AEGISCI_L3_TEST_VAR');
      expect(result).toBe('test-value');
      delete process.env['AEGISCI_L3_TEST_VAR'];
    });

    it('L3-2-3: healthy returns true', async () => {
      const provider = new EnvFileSecretProvider();
      expect(await provider.healthy()).toBe(true);
    });
  });

  describe('EmbeddedPolicyEngine', () => {
    it('L3-3-1: default behavior is fail-closed', async () => {
      const engine = new EmbeddedPolicyEngine();
      const result = await engine.authorize({
        action: 'run',
        resource: 'pipeline',
        principal: 'anyone',
        tenantId: 'any-tenant',
      });
      expect(result.allowed).toBe(false);
      expect(result.reason).toContain('default deny');
    });

    it('L3-3-2: healthy returns true', async () => {
      const engine = new EmbeddedPolicyEngine();
      expect(await engine.healthy()).toBe(true);
    });
  });

  describe('InMemoryAgentProvider', () => {
    it('L3-4-1: register and get agent', async () => {
      const provider = new InMemoryAgentProvider();
      await provider.register({ id: 'agent-l3-1', name: 'TestAgent' });
      const agent = await provider.get('agent-l3-1');
      expect(agent).not.toBeNull();
      expect(agent!.name).toBe('TestAgent');
    });

    it('L3-4-2: get non-existent agent returns null', async () => {
      const provider = new InMemoryAgentProvider();
      expect(await provider.get('nonexistent')).toBeNull();
    });

    it('L3-4-3: list returns all registered agents', async () => {
      const provider = new InMemoryAgentProvider();
      await provider.register({ id: 'a1', name: 'Agent1' });
      await provider.register({ id: 'a2', name: 'Agent2' });
      const list = await provider.list();
      expect(list).toHaveLength(2);
    });
  });

  describe('InMemoryToolProvider', () => {
    it('L3-5-1: register and get tool', async () => {
      const provider = new InMemoryToolProvider();
      await provider.register({ id: 'tool-l3-1', name: 'TestTool' });
      const tool = await provider.get('tool-l3-1');
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe('TestTool');
    });
  });

  describe('InMemorySkillRegistry', () => {
    it('L3-6-1: register and get skill', async () => {
      const registry = new InMemorySkillRegistry();
      await registry.register({ name: 'test-skill', version: '1.0.0' });
      const skill = await registry.get('test-skill', '1.0.0');
      expect(skill).not.toBeNull();
      expect(skill!.version).toBe('1.0.0');
    });
  });

  describe('StubModelGateway', () => {
    it('L3-7-1: chat returns stub response', async () => {
      const gateway = new StubModelGateway();
      const result = await gateway.chat({ model: 'stub', messages: [] });
      expect(result.content).toBe('[stub response]');
    });
  });

  describe('ZeroConfigVerifier', () => {
    let verifier: ZeroConfigVerifier;
    let traceExporter: NoopTraceExporter;
    let secretProvider: EnvFileSecretProvider;
    let policyEngine: EmbeddedPolicyEngine;
    let agentProvider: InMemoryAgentProvider;
    let toolProvider: InMemoryToolProvider;
    let skillRegistry: InMemorySkillRegistry;
    let modelGateway: StubModelGateway;

    beforeEach(() => {
      verifier = new ZeroConfigVerifier();
      traceExporter = new NoopTraceExporter();
      secretProvider = new EnvFileSecretProvider();
      policyEngine = new EmbeddedPolicyEngine();
      agentProvider = new InMemoryAgentProvider();
      toolProvider = new InMemoryToolProvider();
      skillRegistry = new InMemorySkillRegistry();
      modelGateway = new StubModelGateway();
    });

    it('L3-8-1: all SPI checks pass', async () => {
      const results = await verifier.verifyAllSpis(
        traceExporter, secretProvider, policyEngine,
        agentProvider, toolProvider, skillRegistry, modelGateway,
      );
      expect(results.length).toBe(7);
      expect(results.every((r) => r.ok)).toBe(true);
    });

    it('L3-8-2: noop trace latency < 10ms for 1000 spans', async () => {
      const result = await verifier.verifyNoopTrace(traceExporter);
      expect(result.ok).toBe(true);
      expect(result.latencyMs).toBeLessThan(10);
    });

    it('L3-8-3: secret provider handles missing keys gracefully', async () => {
      const result = await verifier.verifySecretProvider(secretProvider);
      expect(result.ok).toBe(true);
    });

    it('L3-8-4: policy engine enforces default deny', async () => {
      const result = await verifier.verifyPolicyEngine(policyEngine);
      expect(result.ok).toBe(true);
    });
  });

  describe('Config Template', () => {
    it('L3-9-1: DEFAULT_CONFIG_TEMPLATE contains all required sections', () => {
      const result = validateConfigTemplate(DEFAULT_CONFIG_TEMPLATE);
      expect(result.ok).toBe(true);
      expect(result.issues).toHaveLength(0);
    });

    it('L3-9-2: template with missing sections fails validation', () => {
      const partial = '# incomplete config\nserver:\n  port: 3000\n';
      const result = validateConfigTemplate(partial);
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });
  });
});
