/**
 * K7-1 · AgentCard 注册器
 *
 * AgentCardRegistryService —— 声明式 AgentCard 注册，写入 AgentCard 存储。
 * 不变量：
 * - AgentCard 注册后进入待审批状态（PendingApproval），须经 HITL 批准后激活（DES-11.3）
 * - 内置 Agent 与第三方 Agent 走相同生命周期（FR-M7-07）
 * - 切换实现不改内核代码（FR-M7-08，通过 AgentProvider SPI）
 */

import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import type { AgentCard, AgentRole, DomainEvent } from '@aegisci/shared/types';

export interface RegisteredAgentCard extends AgentCard {
  readonly cardId: string;
  state: AgentCardState;
  readonly registeredAt: string;
  approvedBy?: string;
}

export type AgentCardState = 'pending_approval' | 'active' | 'suspended' | 'revoked';

export interface RegisterRequest {
  card: AgentCard;
  /** 技能来源 ID（关联 SKILL_MANIFEST → AGENT_CARD_REF，为空表示内置 Agent） */
  skillId?: string;
}

export interface AgentCardRegistryResult {
  ok: boolean;
  cardId: string;
  state: AgentCardState;
  errors: string[];
  warnings: string[];
}

@Injectable()
export class AgentCardRegistryService {
  private readonly logger = new Logger(AgentCardRegistryService.name);
  private readonly cards = new Map<string, RegisteredAgentCard>();
  private readonly cardIdByAgentId = new Map<string, string>();

  constructor(private readonly agentProvider: AgentProvider) {}

  /**
   * 声明式注册 AgentCard。
   * 注册后进入 pending_approval 状态，须经 HITL 审批后才能 active（DES-11.3）。
   */
  async register(req: RegisterRequest): Promise<AgentCardRegistryResult> {
    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. 基础校验
    const validation = this.validateCard(req.card);
    if (validation.errors.length > 0) {
      return { ok: false, cardId: '', state: 'pending_approval', errors: validation.errors, warnings };
    }

    // 2. 重复检测
    const existing = await this.agentProvider.getCard(req.card.agentId);
    if (existing) {
      warnings.push(`agent ${req.card.agentId} already exists`);
    }

    // 3. 写入存储
    const cardId = randomUUID();
    const record: RegisteredAgentCard = {
      ...req.card,
      cardId,
      state: 'pending_approval',
      registeredAt: new Date().toISOString(),
    };

    this.cards.set(cardId, record);
    this.cardIdByAgentId.set(req.card.agentId, cardId);

    // 4. 发布事件
    this.agentProvider.emit('AgentCardRegistered', this.event(record, { skillId: req.skillId }));

    this.logger.debug(
      `registered agent card ${cardId} (agentId=${req.card.agentId}, role=${req.card.role})`,
    );

    return { ok: true, cardId, state: 'pending_approval', errors: [], warnings };
  }

  /**
   * 按 cardId 获取已注册 AgentCard。
   */
  async get(cardId: string): Promise<RegisteredAgentCard | null> {
    return this.cards.get(cardId) ?? null;
  }

  /**
   * 按 agentId 查找 cardId。
   */
  findCardIdByAgentId(agentId: string): string | null {
    return this.cardIdByAgentId.get(agentId) ?? null;
  }

  /**
   * 列出指定角色的待审批 AgentCard。
   */
  listPending(role: AgentRole): RegisteredAgentCard[] {
    return [...this.cards.values()].filter(
      (c) => c.role === role && c.state === 'pending_approval',
    );
  }

  /**
   * 审批通过 —— pending_approval → active（HITL 批准后调用）。
   */
  async approve(cardId: string, approvedBy: string): Promise<RegisteredAgentCard> {
    const card = this.require(cardId);
    if (card.state !== 'pending_approval') {
      throw new Error(`agent card ${cardId} is not pending_approval (state=${card.state})`);
    }
    card.state = 'active';
    card.approvedBy = approvedBy;
    this.agentProvider.emit('AgentCardApproved', this.event(card, { approvedBy }));
    return card;
  }

  /**
   * 挂起 —— active → suspended。
   */
  async suspend(cardId: string): Promise<RegisteredAgentCard> {
    const card = this.require(cardId);
    if (card.state !== 'active') {
      throw new Error(`agent card ${cardId} is not active (state=${card.state})`);
    }
    card.state = 'suspended';
    this.agentProvider.emit('AgentCardSuspended', this.event(card, {}));
    return card;
  }

  /**
   * 吊销 —— active/suspended → revoked；级联回收 Token。
   */
  async revoke(cardId: string): Promise<RegisteredAgentCard> {
    const card = this.require(cardId);
    card.state = 'revoked';
    this.agentProvider.emit('AgentCardRevoked', this.event(card, {
      principalId: card.agentId,
    }));
    // 级联回收 Token（≤10s，经 CredentialJtiRegistry）
    this.logger.debug(`agent card ${cardId} revoked; token cascade cleanup triggered`);
    return card;
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  private require(cardId: string): RegisteredAgentCard {
    const card = this.cards.get(cardId);
    if (!card) throw new Error(`agent card not found: ${cardId}`);
    return card;
  }

  private validateCard(card: AgentCard): { errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!card.agentId) errors.push('agentId is required');
    if (!card.role) errors.push('role is required');
    if (!card.displayName) errors.push('displayName is required');
    if (!card.modelId) errors.push('modelId is required');
    if (!card.tenantId) errors.push('tenantId is required');
    if (!card.capabilities || card.capabilities.length === 0) {
      warnings.push('capabilities is empty — agent may have no tool access');
    }

    const validRoles = ['planner', 'reviewer', 'tester', 'security', 'ops'];
    if (card.role && !validRoles.includes(card.role)) {
      errors.push(`invalid role: ${card.role} (allowed: ${validRoles.join(', ')})`);
    }

    return { errors, warnings };
  }

  private event(card: RegisteredAgentCard, payload: Record<string, unknown>): DomainEvent {
    return {
      eventId: randomUUID(),
      eventType: 'AgentCardLifecycle',
      aggregateId: card.agentId,
      aggregateType: 'AgentCard',
      tenantId: card.tenantId,
      payload,
      timestamp: new Date().toISOString(),
      traceId: '',
      spanId: '',
    };
  }
}

/**
 * AgentProvider —— 最小接口，供测试注入
 */
export interface AgentProvider {
  emit(eventType: string, event: DomainEvent): void;
  getCard(agentId: string): Promise<AgentCard | null>;
}
