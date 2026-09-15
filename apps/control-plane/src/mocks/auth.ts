/**
 * Auth Guard Mock 工具 — 为 auth.guard.spec.ts 提供可复用的 mock 创建函数
 *
 * 仅在 AEGISCI_MOCK_MODE 启用时生成 mock，否则返回 undefined。
 * 但 spec 文件中无条件调用（测试环境始终为 mock），此文件确保类型安全。
 */
import type { AgentTokenRegistry } from '@aegisci/domain/identity';
import type { PrincipalRepository } from '@aegisci/domain/identity';

/**
 * 创建 AgentTokenRegistry mock（替代 auth.guard.spec.ts 中的内联 createMockRegistry）
 */
export function createMockAgentTokenRegistry(): AgentTokenRegistry {
  const entries = new Map<
    string,
    { agentId: string; revoked: boolean; expiresAt: string }
  >();
  return {
    async register(jti, entry) {
      entries.set(jti, {
        agentId: entry.agentId,
        revoked: false,
        expiresAt: entry.expiresAt,
      });
    },
    async revoke(jti) {
      const e = entries.get(jti);
      if (e) entries.set(jti, { ...e, revoked: true });
    },
    async listByAgent(agentId) {
      return [...entries.entries()]
        .filter(([, e]) => e.agentId === agentId && !e.revoked)
        .map(([jti]) => jti);
    },
    async isRevoked(jti) {
      return entries.get(jti)?.revoked ?? false;
    },
  };
}

/**
 * 创建 PrincipalRepository mock（替代 auth.guard.spec.ts 中的内联 createMockRepo）
 */
export function createMockPrincipalRepository(): PrincipalRepository {
  const store = new Map<string, import('@aegisci/domain/identity').PrincipalRecord>();
  const byAgentCard = new Map<string, string>();
  return {
    async save(record) {
      const frozen: any = Object.freeze({ ...record });
      store.set(record.id, frozen);
      if (record.agentCardId) byAgentCard.set(record.agentCardId, record.id);
      return frozen;
    },
    async findById(id) { return store.get(id) ?? null; },
    async findByTenant(tenantId) { return [...store.values()].filter(p => p.tenantId === tenantId); },
    async findByType(type, tenantId?) {
      return [...store.values()].filter(p => p.type === type && (tenantId === undefined || p.tenantId === tenantId));
    },
    async findByAgentCard(agentCardId) {
      const id = byAgentCard.get(agentCardId);
      return id ? (store.get(id) ?? null) : null;
    },
    async delete(id) {
      const existing = store.get(id);
      if (!existing) return false;
      if (existing.agentCardId) byAgentCard.delete(existing.agentCardId);
      return store.delete(id);
    },
  };
}
