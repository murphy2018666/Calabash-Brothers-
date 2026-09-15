import { Injectable } from '@nestjs/common';
import type { AgentProvider } from '@aegisci/core/spi/agents';
import type { AgentCard, AgentRole } from '@aegisci/shared/types';

/**
 * InMemoryAgentProvider —— 内存 Agent 注册提供者（V1.0 默认，SPI 实现）。
 *
 * 不变量（FR-M7-07）：AgentCard 声明式注册，不可动态扩权；
 * 内置与第三方 Agent 走相同生命周期。Map 暂存，进程重启即清空。
 *
 * L2-4 深化：
 * - listTools()：聚合所有已注册 Agent 的 capabilities（去重，运维盘点用）
 * - healthCheck()：返回带 detail 的健康视图（含 registeredCount）
 */

/** AgentProvider 健康详情结构（Impl-level API，非 SPI 契约）。 */
export interface AgentProviderHealthDetail {
  healthy: boolean;
  /** 当前已注册 Agent 数量。 */
  registeredCount: number;
}

@Injectable()
export class InMemoryAgentProvider implements AgentProvider {
  private readonly cards = new Map<string, AgentCard>();

  async register(card: AgentCard): Promise<void> {
    this.cards.set(card.agentId, card);
  }

  async getCard(agentId: string): Promise<AgentCard | null> {
    return this.cards.get(agentId) ?? null;
  }

  async listByRole(role: AgentRole, tenantId: string): Promise<AgentCard[]> {
    return [...this.cards.values()].filter(
      (c) => c.role === role && c.tenantId === tenantId,
    );
  }

  async deregister(agentId: string): Promise<void> {
    this.cards.delete(agentId);
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  /**
   * 聚合所有已注册 Agent 暴露的 capabilities（去重）。
   * 用于运维盘点当前控制面可用工具集合（Impl-level API，非 SPI 契约）。
   */
  async listTools(): Promise<string[]> {
    const set = new Set<string>();
    for (const card of this.cards.values()) {
      for (const cap of card.capabilities) {
        set.add(cap);
      }
    }
    return [...set];
  }

  /**
   * 带详情的健康检查：返回 registeredCount 与 healthy 标记（Impl-level API）。
   * SPI 契约方法 healthy() 仅返回 boolean；运维需要 detail 时调用此方法。
   */
  async healthCheck(): Promise<AgentProviderHealthDetail> {
    return { healthy: true, registeredCount: this.cards.size };
  }
}
