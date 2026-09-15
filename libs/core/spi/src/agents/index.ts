import type { AgentCard, AgentRole, Principal } from '@aegisci/shared/types';

/**
 * AgentProvider SPI —— Agent 注册与加载
 *
 * 不变量：
 * - AgentCard 声明式注册，不可动态扩权
 * - 内置 Agent 与第三方 Agent 走相同生命周期（FR-M7-07）
 * - 切换实现不改内核代码（FR-M7-08）
 */
export interface AgentProvider {
  /** 注册 Agent 卡片（声明式） */
  register(card: AgentCard): Promise<void>;

  /** 按 ID 获取 Agent 卡片 */
  getCard(agentId: string): Promise<AgentCard | null>;

  /** 按角色列出已激活 Agent */
  listByRole(role: AgentRole, tenantId: string): Promise<AgentCard[]>;

  /** 注销 Agent（级联回收 Token） */
  deregister(agentId: string): Promise<void>;

  /** 健康检查 */
  healthy(): Promise<boolean>;
}
