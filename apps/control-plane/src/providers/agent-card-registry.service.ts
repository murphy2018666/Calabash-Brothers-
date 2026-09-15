/**
 * E2-1: AgentCardRegistryService —— AgentCard 注册中心（编排层）
 *
 * 在 InMemoryAgentProvider 基础上提供：
 * - 按角色发现 Agent（带健康检查过滤）
 * - Token 预算注入（从 AgentCard 读取 model.budget，缺省 8000）
 * - 角色→AgentCard 映射缓存
 * - 注销时级联回收 Token 预算
 *
 * 不变量（FR-M7-07）：
 * - AgentCard 声明式注册，不可动态扩权
 * - 内置与第三方 Agent 走相同生命周期
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import type { AgentCard, AgentRole } from '@aegisci/shared/types';
import { AgentProvider, SPI_TOKENS } from '@aegisci/core/spi';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 暴露的 Agent 信息（不含敏感字段）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface DiscoveredAgent {
  agentId: string;
  role: AgentRole;
  displayName: string;
  modelId: string;
  tokenBudget: number;
  capabilities: string[];
  riskTier: string;
}

export interface AgentRegistryResult {
  agents: DiscoveredAgent[];
  totalRegistered: number;
  healthyCount: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULT_TOKEN_BUDGET = 8000;

@Injectable()
export class AgentCardRegistryService {
  private readonly logger = new Logger(AgentCardRegistryService.name);
  /** 按 `${role}|${tenantId}` 缓存已发现 Agent 列表 */
  private readonly roleCache = new Map<string, DiscoveredAgent[]>();

  constructor(
    @Inject(SPI_TOKENS.AGENT_PROVIDER)
    private readonly agentProvider: AgentProvider,
  ) {}

  /**
   * 按角色发现可用 Agent（带健康检查过滤 + Token 预算注入）。
   * 返回结果缓存于 roleCache，key = `${role}|${tenantId}`，下次调用直接返回缓存。
   */
  async discoverByRole(role: AgentRole, tenantId: string): Promise<DiscoveredAgent[]> {
    // 检查缓存（按 role + tenantId 联合 key）
    const cacheKey = `${role}|${tenantId}`;
    const cached = this.roleCache.get(cacheKey);
    if (cached && cached.length > 0) {
      return cached;
    }

    const cards = await this.agentProvider.listByRole(role, tenantId);
    const healthyCards = cards.filter(async (c) => {
      try {
        return await this.agentProvider.healthy();
      } catch {
        return false;
      }
    });

    // 并行执行健康检查
    const healthyPromises = cards.map(async (c) => {
      try {
        const isHealthy = await this.agentProvider.healthy();
        return isHealthy ? c : null;
      } catch {
        return null;
      }
    });
    const healthyResults = await Promise.all(healthyPromises);
    const validCards = healthyResults.filter((c): c is AgentCard => c !== null);

    const discovered = validCards.map((c) => this.toDiscoveredAgent(c));
    this.roleCache.set(cacheKey, discovered);

    this.logger.log(`Discovered ${discovered.length} ${role} agent(s) for tenant=${tenantId}`);
    return discovered;
  }

  /**
   * 列出所有已注册角色的 Agent（全量盘点）。
   */
  async listAll(tenantId: string): Promise<AgentRegistryResult> {
    const roles: AgentRole[] = ['planner', 'reviewer', 'tester', 'security', 'ops'];
    const allAgents: DiscoveredAgent[] = [];

    for (const role of roles) {
      const agents = await this.discoverByRole(role, tenantId);
      allAgents.push(...agents);
    }

    const healthyCount = allAgents.length; // 已通过健康检查过滤

    return {
      agents: allAgents,
      totalRegistered: allAgents.length,
      healthyCount,
    };
  }

  /**
   * 注销 Agent（级联回收 Token 预算）。
   * 同时清除角色缓存。
   */
  async deregister(agentId: string): Promise<void> {
    await this.agentProvider.deregister(agentId);
    // 清除所有缓存
    this.roleCache.clear();
    this.logger.log(`Agent ${agentId} deregistered, role cache cleared`);
  }

  /**
   * 刷新角色缓存（主动失效）。
   */
  async refreshCache(): Promise<void> {
    this.roleCache.clear();
    this.logger.log('Agent registry cache refreshed');
  }

  /**
   * 健康检查汇总。
   */
  async healthCheck(): Promise<{ healthy: boolean; agentCount: number }> {
    const all = await this.listAll('tenant-1');
    return {
      healthy: all.healthyCount > 0,
      agentCount: all.healthyCount,
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 私有
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private toDiscoveredAgent(card: AgentCard): DiscoveredAgent {
    // 从 AgentCard 中提取 Token 预算（DES-8：model.budget）
    const anyCard = card as unknown as { model?: { budget?: number } };
    const tokenBudget = anyCard.model?.budget ?? DEFAULT_TOKEN_BUDGET;

    return {
      agentId: card.agentId,
      role: card.role,
      displayName: card.displayName,
      modelId: card.modelId,
      tokenBudget,
      capabilities: card.capabilities,
      riskTier: card.riskTier,
    };
  }
}
