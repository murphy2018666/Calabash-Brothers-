import { Controller, Get, Inject } from '@nestjs/common';
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
import { KERNEL_COMPONENTS } from '@aegisci/core/kernel';

/**
 * HealthController —— 控制面健康检查（ADD §10 AG-1 架构守护）。
 * GET /api/v1/health 返回内核组件 + SPI 提供者健康状态。
 */
@Controller('health')
export class HealthController {
  constructor(
    @Inject(SPI_TOKENS.TRACE_EXPORTER) private readonly trace: TraceExporter,
    @Inject(SPI_TOKENS.SECRET_PROVIDER) private readonly secret: SecretProvider,
    @Inject(SPI_TOKENS.POLICY_ENGINE) private readonly policy: PolicyEngineSPI,
    @Inject(SPI_TOKENS.AGENT_PROVIDER) private readonly agent: AgentProvider,
    @Inject(SPI_TOKENS.TOOL_PROVIDER) private readonly tool: ToolProvider,
    @Inject(SPI_TOKENS.SKILL_REGISTRY) private readonly skill: SkillRegistrySPI,
    @Inject(SPI_TOKENS.MODEL_GATEWAY) private readonly model: ModelGateway,
  ) {}

  @Get()
  async health(): Promise<{
    status: 'ok' | 'degraded';
    components: Record<string, boolean>;
  }> {
    const [trace, secret, policy, agent, tool, skill, model] = await Promise.all([
      this.trace.healthy(),
      this.secret.healthy(),
      this.policy.healthy(),
      this.agent.healthy(),
      this.tool.healthy(),
      this.skill.healthy(),
      this.model.healthy(),
    ]);

    const components: Record<string, boolean> = {
      // 内核组件（6，不可关闭）
      RunStateMachine: true,
      PolicyEngine: policy,
      AgentCredential: agent && secret,
      Blackboard: true,
      EventBus: true,
      AuditWorm: true,
      // SPI 提供者（7，可插拔）
      TraceExporter: trace,
      SecretProvider: secret,
      PolicyEngineSpi: policy,
      AgentProvider: agent,
      ToolProvider: tool,
      SkillRegistry: skill,
      ModelGateway: model,
    };

    const allHealthy =
      Object.values(components).every((value) => value === true) &&
      KERNEL_COMPONENTS.every((component: string) => components[component] === true);
    return { status: allHealthy ? 'ok' : 'degraded', components };
  }
}
