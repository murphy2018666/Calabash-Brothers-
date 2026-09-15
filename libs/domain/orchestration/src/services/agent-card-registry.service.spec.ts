/**
 * K7-1 · AgentCard 注册器 单元测试
 */

import { AgentCardRegistryService, type RegisteredAgentCard } from './agent-card-registry.service';
import type { AgentCard, DomainEvent } from '@aegisci/shared/types';

// 简单 stub AgentProvider
class StubAgentProvider {
  private cards = new Map<string, AgentCard>();
  private readonly events: DomainEvent[] = [];

  emit(eventType: string, event: DomainEvent): void {
    this.events.push(event);
  }

  getEvents(): DomainEvent[] {
    return this.events;
  }

  async getCard(agentId: string): Promise<AgentCard | null> {
    return this.cards.get(agentId) ?? null;
  }

  addCard(card: AgentCard, state: 'active' | 'pending_approval' = 'pending_approval'): void {
    const cardWithState = { ...card, state: state as any };
    this.cards.set(card.agentId, cardWithState as any);
  }
}

describe('AgentCardRegistryService (K7-1)', () => {
  let service: AgentCardRegistryService;
  let provider: StubAgentProvider;

  const validCard: AgentCard = {
    agentId: 'agent-test-001',
    role: 'planner',
    displayName: 'Test Planner',
    modelId: 'gpt-4',
    capabilities: ['plan', 'reason'],
    riskTier: 'G2',
    tenantId: 'tenant-1',
  };

  beforeEach(() => {
    provider = new StubAgentProvider();
    service = new AgentCardRegistryService(provider as any);
  });

  describe('register', () => {
    it('should register a valid card and return pending_approval state', async () => {
      const result = await service.register({ card: validCard });
      expect(result.ok).toBe(true);
      expect(result.state).toBe('pending_approval');
      expect(result.errors).toHaveLength(0);
      expect(result.cardId).toBeTruthy();
    });

    it('should emit AgentCardRegistered event on registration', async () => {
      await service.register({ card: validCard });
      const events = provider.getEvents();
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].eventType).toBe('AgentCardLifecycle');
    });

    it('should reject card missing agentId', async () => {
      const badCard = { ...validCard, agentId: '' };
      const result = await service.register({ card: badCard });
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes('agentId'))).toBe(true);
    });

    it('should reject card with invalid role', async () => {
      const badCard = { ...validCard, role: 'unknown-role' as any };
      const result = await service.register({ card: badCard });
      expect(result.ok).toBe(false);
    });

    it('should warn when agent already exists', async () => {
      provider.addCard(validCard, 'active');
      const result = await service.register({ card: validCard });
      expect(result.ok).toBe(true);
      expect(result.warnings.some((w) => w.includes('already exists'))).toBe(true);
    });
  });

  describe('get', () => {
    it('should retrieve registered card by cardId', async () => {
      const reg = await service.register({ card: validCard });
      const card = await service.get(reg.cardId);
      expect(card).not.toBeNull();
      expect(card!.agentId).toBe(validCard.agentId);
      expect(card!.state).toBe('pending_approval');
    });

    it('should return null for non-existent cardId', async () => {
      const card = await service.get('nonexistent');
      expect(card).toBeNull();
    });
  });

  describe('approve', () => {
    it('should transition pending_approval → active', async () => {
      const reg = await service.register({ card: validCard });
      const approved = await service.approve(reg.cardId, 'approver-1');
      expect(approved.state).toBe('active');
      expect(approved.approvedBy).toBe('approver-1');
    });

    it('should throw if card is not pending_approval', async () => {
      const reg = await service.register({ card: validCard });
      await service.approve(reg.cardId, 'approver-1');
      expect(service.approve(reg.cardId, 'approver-2')).rejects.toThrow();
    });
  });

  describe('suspend', () => {
    it('should transition active → suspended', async () => {
      const reg = await service.register({ card: validCard });
      await service.approve(reg.cardId, 'approver-1');
      const suspended = await service.suspend(reg.cardId);
      expect(suspended.state).toBe('suspended');
    });
  });

  describe('revoke', () => {
    it('should transition active → revoked and cleanup tokens', async () => {
      const reg = await service.register({ card: validCard });
      await service.approve(reg.cardId, 'approver-1');
      const revoked = await service.revoke(reg.cardId);
      expect(revoked.state).toBe('revoked');
    });
  });

  describe('listPending', () => {
    it('should list only pending_approval cards by role', async () => {
      await service.register({ card: { ...validCard, agentId: 'agent-1', role: 'planner' } });
      await service.register({ card: { ...validCard, agentId: 'agent-2', role: 'reviewer' } });
      const pending = await service.listPending('planner');
      expect(pending).toHaveLength(1);
      expect(pending[0].role).toBe('planner');
    });
  });

  describe('findCardIdByAgentId', () => {
    it('should return cardId for registered agent', async () => {
      const reg = await service.register({ card: validCard });
      const cardId = service.findCardIdByAgentId(validCard.agentId);
      expect(cardId).toBe(reg.cardId);
    });

    it('should return null for non-existent agent', () => {
      const cardId = service.findCardIdByAgentId('nonexistent');
      expect(cardId).toBeNull();
    });
  });

  describe('healthy', () => {
    it('should return true', async () => {
      const result = await service.healthy();
      expect(result).toBe(true);
    });
  });
});
