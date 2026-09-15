/**
 * AegisCI SPI（Service Provider Interface）接口定义
 *
 * 对应设计文档：
 * - DES-13 可插拔架构
 * - ADD §7 内核 + SPI
 * - FR-M7-02 SPI 接口定义与 DI 注入
 *
 * 七个 SPI 接口可替换实现，但控制点在内核：
 * 1. AgentProvider    —— Agent 注册与加载
 * 2. ToolProvider     —— ACI 工具实现
 * 3. ModelGateway      —— LLM 模型网关（含 Token 预算器）
 * 4. TraceExporter     —— 链路追踪导出
 * 5. SecretProvider    —— 密钥与凭证管理
 * 6. PolicyEngine      —— 策略求值引擎
 * 7. SkillRegistry     —— 技能注册仓库
 *
 * 规则（DES-13.9 安全/效能交叉保证）：
 * - 可替换的是"实现"，不可替换的是"控制点"
 * - 每个 SPI 的不变量在接口注释中声明
 * - 切换实现不改内核代码（FR-M7-08）
 */

export type { AgentProvider } from './agents';
export type { ToolProvider } from './tools';
export type { ModelGateway } from './models';
export type { TraceExporter } from './trace';
export type { SecretProvider } from './secrets';
export type { PolicyEngineSPI, PolicyRule } from './policy';
export type { SkillRegistrySPI } from './skills';

// DI 注入令牌
export const SPI_TOKENS = {
  AGENT_PROVIDER: Symbol('SPI_AGENT_PROVIDER'),
  TOOL_PROVIDER: Symbol('SPI_TOOL_PROVIDER'),
  MODEL_GATEWAY: Symbol('SPI_MODEL_GATEWAY'),
  TRACE_EXPORTER: Symbol('SPI_TRACE_EXPORTER'),
  SECRET_PROVIDER: Symbol('SPI_SECRET_PROVIDER'),
  POLICY_ENGINE: Symbol('SPI_POLICY_ENGINE'),
  SKILL_REGISTRY: Symbol('SPI_SKILL_REGISTRY'),
} as const;
