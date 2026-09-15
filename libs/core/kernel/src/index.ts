/**
 * AegisCI 内核定义
 *
 * 对应设计文档：
 * - DES-13 薄内核可插拔架构
 * - ADD §7 内核 + SPI
 * - FR-M7-01 内核 MVP 定义
 *
 * 6 个内核组件不可插拔、不可关闭：
 * 1. Run 状态机
 * 2. Policy 权限引擎
 * 3. Agent 身份与凭证
 * 4. Blackboard 黑板
 * 5. NATS 事件总线
 * 6. Audit WORM 审计
 *
 * 3 条内核不变量（违反即 CI 守护测试失败）：
 * 1. 每次 Agent 工具调用必过 Policy
 * 2. 所有 Agent 动作必入 WORM 审计
 * 3. Agent 间通信必走 Blackboard
 */

export const KERNEL_COMPONENTS = [
  'RunStateMachine',
  'PolicyEngine',
  'AgentCredential',
  'Blackboard',
  'EventBus',
  'AuditWorm',
] as const;

export type KernelComponent = (typeof KERNEL_COMPONENTS)[number];

export const KERNEL_INVARIANTS = [
  'EVERY_TOOL_CALL_AUTHORIZE',
  'EVERY_AGENT_ACTION_AUDITED',
  'AGENT_COMMUNICATION_VIA_BLACKBOARD',
] as const;

export type KernelInvariant = (typeof KERNEL_INVARIANTS)[number];

export const KERNEL_INVARIANT_DESCRIPTIONS: Record<KernelInvariant, string> = {
  EVERY_TOOL_CALL_AUTHORIZE: '每次 Agent 工具调用必经 Policy Engine 裁决（FR-M7-01 不变量 1）',
  EVERY_AGENT_ACTION_AUDITED: '所有 Agent 动作必入 WORM 审计（FR-M7-01 不变量 2）',
  AGENT_COMMUNICATION_VIA_BLACKBOARD: 'Agent 间通信必走 Blackboard（FR-M7-01 不变量 3）',
};

/**
 * 内核组件标记符号 —— 用于 NestJS Provider 注入
 */
export const KERNEL_TOKENS = {
  RUN_STATE_MACHINE: Symbol('RUN_STATE_MACHINE'),
  POLICY_ENGINE: Symbol('POLICY_ENGINE'),
  AGENT_CREDENTIAL: Symbol('AGENT_CREDENTIAL'),
  BLACKBOARD: Symbol('BLACKBOARD'),
  EVENT_BUS: Symbol('EVENT_BUS'),
  AUDIT_WORM: Symbol('AUDIT_WORM'),
} as const;

/**
 * 内核不变量守卫接口
 * 由控制面在启动时注入，每次工具调用/审计写入/黑板通信时校验
 */
export interface InvariantGuard {
  readonly invariant: KernelInvariant;
  check(): boolean;
  readonly lastViolation?: string;
}

/**
 * 内核健康检查接口
 * ADD §10 AG-1 架构守护套件使用
 */
export interface KernelHealthCheck {
  component: KernelComponent;
  healthy: boolean;
  detail: string;
}
