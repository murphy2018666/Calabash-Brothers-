import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AgentCard, Principal, PrincipalType } from '@aegisci/shared/types';
// type-only import：避免运行时循环依赖（identity.module.ts 反向 import IdentityService）
import type { PrincipalRepository } from './identity.module';

/**
 * PrincipalRepository 端口令牌（DI 注入键）。
 *
 * 设计：与 AGENT_TOKEN_REGISTRY 模式一致，符号在消费者文件本地定义，
 * 避免与 identity.module.ts 产生运行时循环依赖。
 * identity.module.ts 通过 re-export 暴露给外部消费者。
 */
export const PRINCIPAL_REPOSITORY = Symbol('PRINCIPAL_REPOSITORY');

/**
 * Identity 子域服务 —— 主体注册与查询（DES-3 ID 上下文 / DES-5.1 三元主体）。
 * 主体三类：User / Service / Agent，均为一等被授权主体。
 *
 * 持久化档位（S2 深化）：
 * - 默认：PrincipalRepository 端口的 InMemoryPrincipalRepository 实现（本模块内置）
 * - 未来：切换 PG 实现（仅替换 PrincipalRepository 实现，不改 IdentityService 代码）
 *
 * 不变量：
 * - 三类主体（User/Service/Agent）均为一等被授权主体
 * - Agent 主体与 AgentCard 单向绑定（capability 声明式，不可动态扩权）
 * - 多租户隔离：跨租户查询必须显式传 tenantId
 */
export interface PrincipalRecord extends Principal {
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly displayName: string;
  /** Agent 主体绑定的 AgentCard.agentId（仅 type='agent' 时设置）。 */
  readonly agentCardId?: string;
  /** Agent 主体绑定的能力清单快照（来自 AgentCard.capabilities）。 */
  readonly capabilities?: readonly string[];
}

/** 主体检索条件。 */
export interface PrincipalQuery {
  readonly tenantId?: string;
  readonly type?: PrincipalType;
}

/** 主体更新输入（部分字段；id/createdAt 不可变）。 */
export interface PrincipalUpdateInput {
  readonly roles?: readonly string[];
  readonly displayName?: string;
}

@Injectable()
export class IdentityService {
  private readonly logger = new Logger(IdentityService.name);

  constructor(
    @Inject(PRINCIPAL_REPOSITORY) private readonly repo: PrincipalRepository,
  ) {}

  /**
   * 注册主体（通用入口，兼容 S1 签名）。
   * 优先使用 registerUser/registerServiceAccount/registerAgent 类型化入口。
   */
  async register(
    type: PrincipalType,
    tenantId: string,
    roles: readonly string[],
    displayName: string,
  ): Promise<PrincipalRecord> {
    const now = new Date().toISOString();
    const record: PrincipalRecord = {
      id: randomUUID(),
      type,
      tenantId,
      roles: [...roles],
      createdAt: now,
      updatedAt: now,
      displayName,
    };
    const saved = await this.repo.save(record);
    this.logger.log(`registered principal ${saved.id} (type=${type})`);
    return saved;
  }

  /** 注册 User 主体（type='user'）。 */
  async registerUser(
    tenantId: string,
    roles: readonly string[],
    displayName: string,
  ): Promise<PrincipalRecord> {
    return this.register('user', tenantId, roles, displayName);
  }

  /** 注册 ServiceAccount 主体（type='service'，用于服务间调用）。 */
  async registerServiceAccount(
    tenantId: string,
    roles: readonly string[],
    displayName: string,
  ): Promise<PrincipalRecord> {
    return this.register('service', tenantId, roles, displayName);
  }

  /**
   * 注册 Agent 主体（type='agent'，绑定 AgentCard）。
   * 不变量：Agent 主体能力清单快照自 AgentCard.capabilities，签发 Token 时收窄使用。
   */
  async registerAgent(card: AgentCard): Promise<PrincipalRecord> {
    const now = new Date().toISOString();
    const record: PrincipalRecord = {
      id: randomUUID(),
      type: 'agent',
      tenantId: card.tenantId,
      roles: [`agent:${card.role}`],
      createdAt: now,
      updatedAt: now,
      displayName: card.displayName,
      agentCardId: card.agentId,
      capabilities: [...card.capabilities],
    };
    const saved = await this.repo.save(record);
    this.logger.log(
      `registered agent principal ${saved.id} (agentId=${card.agentId}, role=${card.role})`,
    );
    return saved;
  }

  /** 按 ID 查询主体。 */
  async lookup(id: string): Promise<PrincipalRecord | null> {
    return this.repo.findById(id);
  }

  /** 按 email/displayName 查询 User 主体（用于 SSO 登录匹配）。 */
  async findByEmail(email: string, tenantId: string): Promise<PrincipalRecord | null> {
    const users = await this.repo.findByType('user', tenantId);
    return users.find((u) => u.displayName === email) ?? null;
  }

  /** 按租户列出主体。 */
  async listByTenant(tenantId: string): Promise<PrincipalRecord[]> {
    return this.repo.findByTenant(tenantId);
  }

  /** 按类型列出主体（可选 tenantId 收窄到指定租户）。 */
  async listByType(
    type: PrincipalType,
    tenantId?: string,
  ): Promise<PrincipalRecord[]> {
    return this.repo.findByType(type, tenantId);
  }

  /** 按 AgentCard.agentId 查询 Agent 主体（Agent ↔ Principal 单向绑定）。 */
  async findByAgentCard(agentCardId: string): Promise<PrincipalRecord | null> {
    return this.repo.findByAgentCard(agentCardId);
  }

  /** 更新主体（部分字段；id/createdAt/type/tenantId/agentCardId 不可变）。 */
  async update(
    id: string,
    patch: PrincipalUpdateInput,
  ): Promise<PrincipalRecord> {
    const existing = await this.repo.findById(id);
    if (!existing) {
      throw new Error(`principal not found: ${id}`);
    }
    const updated: PrincipalRecord = {
      ...existing,
      roles: patch.roles ? [...patch.roles] : existing.roles,
      displayName: patch.displayName ?? existing.displayName,
      updatedAt: new Date().toISOString(),
    };
    return this.repo.save(updated);
  }

  /** 删除主体。返回是否删除了既有记录。 */
  async delete(id: string): Promise<boolean> {
    return this.repo.delete(id);
  }
}
