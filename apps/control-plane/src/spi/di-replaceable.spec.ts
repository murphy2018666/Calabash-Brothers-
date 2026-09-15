import { Test } from '@nestjs/testing';
import {
  SPI_TOKENS,
  type AgentProvider,
  type ModelGateway,
  type PolicyEngineSPI,
  type SecretProvider,
  type SkillRegistrySPI,
  type ToolProvider,
  type TraceExporter,
} from '@aegisci/core/spi';
import { SpiDefaultsModule } from '../providers/spi-defaults.module';
import { MockTraceExporter, MockSecretProvider, MockPolicyEngine, MockAgentProvider, MockToolProvider, MockSkillRegistry, MockModelGateway } from '../mocks/factory';

/**
 * L2-6 DI 注入验证 —— 7 个 SPI 均可在不改内核代码的前提下替换为 mock 实现
 * （FR-M7-08 纯加法扩展保证 / DES-13.9 可插拔边界）。
 *
 * 验证方式：
 * 1. 用 Test.createTestingModule 导入 SpiDefaultsModule，断言 7 个 SPI 令牌
 *    均解析为默认实现（装配完整性）。
 * 2. 用 overrideProvider 将每个 SPI 令牌替换为 mock，断言解析结果是 mock
 *    实例 —— 内核/控制面代码零修改。
 */

describe('L2-6 SPI DI replaceability (FR-M7-08)', () => {
  it('SpiDefaultsModule resolves all 7 SPI tokens to default implementations', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SpiDefaultsModule],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get<TraceExporter>(SPI_TOKENS.TRACE_EXPORTER).name).toBe('noop');
    expect(moduleRef.get<PolicyEngineSPI>(SPI_TOKENS.POLICY_ENGINE).getPolicyVersion()).toBeTruthy();
    expect(moduleRef.get<AgentProvider>(SPI_TOKENS.AGENT_PROVIDER)).toBeInstanceOf(Object);
    expect(moduleRef.get<ToolProvider>(SPI_TOKENS.TOOL_PROVIDER).name).toBe('echo');
    expect(moduleRef.get<SkillRegistrySPI>(SPI_TOKENS.SKILL_REGISTRY)).toBeInstanceOf(Object);
    expect(moduleRef.get<SecretProvider>(SPI_TOKENS.SECRET_PROVIDER)).toBeInstanceOf(Object);
    expect(moduleRef.get<ModelGateway>(SPI_TOKENS.MODEL_GATEWAY)).toBeInstanceOf(Object);
  });

  it('every SPI token can be overridden with a mock without kernel changes', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [SpiDefaultsModule],
    })
      .overrideProvider(SPI_TOKENS.TRACE_EXPORTER)
      .useClass(MockTraceExporter)
      .overrideProvider(SPI_TOKENS.SECRET_PROVIDER)
      .useClass(MockSecretProvider)
      .overrideProvider(SPI_TOKENS.POLICY_ENGINE)
      .useClass(MockPolicyEngine)
      .overrideProvider(SPI_TOKENS.AGENT_PROVIDER)
      .useClass(MockAgentProvider)
      .overrideProvider(SPI_TOKENS.TOOL_PROVIDER)
      .useClass(MockToolProvider)
      .overrideProvider(SPI_TOKENS.SKILL_REGISTRY)
      .useClass(MockSkillRegistry)
      .overrideProvider(SPI_TOKENS.MODEL_GATEWAY)
      .useClass(MockModelGateway)
      .compile();
    await moduleRef.init();

    expect(moduleRef.get<TraceExporter>(SPI_TOKENS.TRACE_EXPORTER)).toBeInstanceOf(
      MockTraceExporter,
    );
    expect(moduleRef.get<SecretProvider>(SPI_TOKENS.SECRET_PROVIDER)).toBeInstanceOf(
      MockSecretProvider,
    );
    expect(
      moduleRef.get<PolicyEngineSPI>(SPI_TOKENS.POLICY_ENGINE).getPolicyVersion(),
    ).toBe('mock-v1');
    expect(moduleRef.get<AgentProvider>(SPI_TOKENS.AGENT_PROVIDER)).toBeInstanceOf(
      MockAgentProvider,
    );
    expect(moduleRef.get<ToolProvider>(SPI_TOKENS.TOOL_PROVIDER)).toBeInstanceOf(
      MockToolProvider,
    );
    expect(moduleRef.get<SkillRegistrySPI>(SPI_TOKENS.SKILL_REGISTRY)).toBeInstanceOf(
      MockSkillRegistry,
    );
    expect(moduleRef.get<ModelGateway>(SPI_TOKENS.MODEL_GATEWAY)).toBeInstanceOf(
      MockModelGateway,
    );
  });

  it('per-token override works independently (partial replacement)', async () => {
    // 仅替换 PolicyEngine，其余保持默认 —— 单测中替换单一 SPI 的常见场景。
    const moduleRef = await Test.createTestingModule({
      imports: [SpiDefaultsModule],
    })
      .overrideProvider(SPI_TOKENS.POLICY_ENGINE)
      .useClass(MockPolicyEngine)
      .compile();
    await moduleRef.init();

    expect(
      moduleRef.get<PolicyEngineSPI>(SPI_TOKENS.POLICY_ENGINE).getPolicyVersion(),
    ).toBe('mock-v1');
    // 默认实现仍在位
    expect(moduleRef.get<TraceExporter>(SPI_TOKENS.TRACE_EXPORTER).name).toBe('noop');
  });
});
