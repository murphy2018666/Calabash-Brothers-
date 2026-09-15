import { Test } from '@nestjs/testing';
import { KERNEL_COMPONENTS } from '@aegisci/core/kernel';
import { SPI_TOKENS } from '@aegisci/core/spi';
import { NoopTraceExporter } from '../providers/noop-trace-exporter';
import { EnvFileSecretProvider } from '../providers/env-file-secret-provider';
import { EmbeddedPolicyEngine } from '../providers/embedded-policy-engine';
import { InMemoryAgentProvider } from '../providers/in-memory-agent-provider';
import { InMemoryToolProvider } from '../providers/in-memory-tool-provider';
import { InMemorySkillRegistry } from '../providers/in-memory-skill-registry';
import { StubModelGateway } from '../providers/stub-model-gateway';
import { HealthController } from './health.controller';

/**
 * 健康检查集成测试 —— GET /api/v1/health
 * 验证所有内核组件 + SPI 默认实现健康（ADD §10 AG-1 架构守护）。
 */
describe('HealthController', () => {
  let controller: HealthController;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        NoopTraceExporter,
        EnvFileSecretProvider,
        EmbeddedPolicyEngine,
        InMemoryAgentProvider,
        InMemoryToolProvider,
        InMemorySkillRegistry,
        StubModelGateway,
        { provide: SPI_TOKENS.TRACE_EXPORTER, useExisting: NoopTraceExporter },
        { provide: SPI_TOKENS.SECRET_PROVIDER, useExisting: EnvFileSecretProvider },
        { provide: SPI_TOKENS.POLICY_ENGINE, useExisting: EmbeddedPolicyEngine },
        { provide: SPI_TOKENS.AGENT_PROVIDER, useExisting: InMemoryAgentProvider },
        { provide: SPI_TOKENS.TOOL_PROVIDER, useExisting: InMemoryToolProvider },
        { provide: SPI_TOKENS.SKILL_REGISTRY, useExisting: InMemorySkillRegistry },
        { provide: SPI_TOKENS.MODEL_GATEWAY, useExisting: StubModelGateway },
      ],
    }).compile();
    controller = moduleRef.get(HealthController);
  });

  it('GET /health returns status "ok" with all kernel components healthy', async () => {
    const result = await controller.health();
    expect(result.status).toBe('ok');
    for (const component of KERNEL_COMPONENTS) {
      expect(result.components[component]).toBe(true);
    }
  });

  it('reports SPI provider health', async () => {
    const result = await controller.health();
    expect(result.components.TraceExporter).toBe(true);
    expect(result.components.SecretProvider).toBe(true);
    expect(result.components.PolicyEngine).toBe(true);
    expect(result.components.AgentProvider).toBe(true);
    expect(result.components.ToolProvider).toBe(true);
    expect(result.components.SkillRegistry).toBe(true);
    expect(result.components.ModelGateway).toBe(true);
  });

  it('degrades to "degraded" when an SPI provider is unhealthy', async () => {
    // 直接用一个返回 false 的 TraceExporter 健康检查验证降级路径
    const moduleRef = await Test.createTestingModule({
      controllers: [HealthController],
      providers: [
        {
          provide: SPI_TOKENS.TRACE_EXPORTER,
          useValue: {
            name: 'broken',
            export: jest.fn(),
            healthy: jest.fn().mockResolvedValue(false),
          },
        },
        EnvFileSecretProvider,
        EmbeddedPolicyEngine,
        InMemoryAgentProvider,
        InMemoryToolProvider,
        InMemorySkillRegistry,
        StubModelGateway,
        { provide: SPI_TOKENS.SECRET_PROVIDER, useExisting: EnvFileSecretProvider },
        { provide: SPI_TOKENS.POLICY_ENGINE, useExisting: EmbeddedPolicyEngine },
        { provide: SPI_TOKENS.AGENT_PROVIDER, useExisting: InMemoryAgentProvider },
        { provide: SPI_TOKENS.TOOL_PROVIDER, useExisting: InMemoryToolProvider },
        { provide: SPI_TOKENS.SKILL_REGISTRY, useExisting: InMemorySkillRegistry },
        { provide: SPI_TOKENS.MODEL_GATEWAY, useExisting: StubModelGateway },
      ],
    }).compile();
    const degradedController = moduleRef.get(HealthController);
    const result = await degradedController.health();
    expect(result.status).toBe('degraded');
    expect(result.components.TraceExporter).toBe(false);
  });
});
