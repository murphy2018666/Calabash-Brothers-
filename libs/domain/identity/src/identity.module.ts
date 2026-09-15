import { Module } from '@nestjs/common';
import {
  IdentityService,
  PRINCIPAL_REPOSITORY,
  type PrincipalRecord,
  type PrincipalQuery,
} from './identity.service';
import { TokenService } from './token.service';
import { OidcProviderService } from './oidc-provider.service';

// re-export 端口令牌 + PrincipalRecord/Query 类型，供外部消费者（如 SpiDefaultsModule）引用
export {
  PRINCIPAL_REPOSITORY,
} from './identity.service';
export type {
  PrincipalRecord,
  PrincipalQuery,
} from './identity.service';

/**
 * Identity 子域 NestJS 模块（DES-3 ID 上下文）。
 *
 * 端口装配：
 * - AGENT_TOKEN_REGISTRY：Agent 身份令牌 JTI 登记册（实现由控制面注入，默认 SpiDefaultsModule）
 * - PRINCIPAL_REPOSITORY：主体持久化端口（实现可替换，未来切换 PG；默认本模块内置 InMemoryPrincipalRepository）
 */

/**
 * PrincipalRepository 端口 —— 主体持久化抽象（DES-3 ID 上下文 / S2 深化）。
 *
 * 不变量：
 * - 同一 id 在 save() 后必能被 findById() 命中（read-your-writes 一致性）
 * - delete() 返回是否删除了既有记录；不存在返回 false
 * - 按 tenant / type / agentCard 检索不得跨租户返回（多租户隔离）
 *
 * 实现档位：
 * - S2 默认：InMemoryPrincipalRepository（本模块内置 Map 桩，进程重启即清空）
 * - S3+ 目标：替换为 PG 实现，控制点在控制面（不修改本端口契约）
 */
export interface PrincipalRepository {
  save(record: PrincipalRecord): Promise<PrincipalRecord>;
  findById(id: string): Promise<PrincipalRecord | null>;
  findByTenant(tenantId: string): Promise<PrincipalRecord[]>;
  findByType(type: PrincipalQuery['type'], tenantId?: string): Promise<PrincipalRecord[]>;
  findByAgentCard(agentCardId: string): Promise<PrincipalRecord | null>;
  delete(id: string): Promise<boolean>;
}

/**
 * InMemoryPrincipalRepository —— S2 默认主体持久化桩（进程内 Map）。
 *
 * 设计意图：保持 IdentityModule 自包含（不依赖控制面装配即可独立启动 + 测试）。
 * 控制面可通过 SpiDefaultsModule 提供更精细的实现覆盖此默认
 * （see apps/control-plane/src/providers/in-memory-principal-repository.ts）。
 *
 * 不变量：
 * - 写入即冻结（Object.freeze），防止外部可变修改（与"主体不可动态扩权"对齐）
 * - byAgentCard 反向索引与 store 同步增删
 */
class InMemoryPrincipalRepository implements PrincipalRepository {
  private readonly store = new Map<string, PrincipalRecord>();
  private readonly byAgentCard = new Map<string, string>();

  async save(record: PrincipalRecord): Promise<PrincipalRecord> {
    const frozen: PrincipalRecord = Object.freeze({ ...record });
    this.store.set(record.id, frozen);
    if (record.agentCardId) {
      this.byAgentCard.set(record.agentCardId, record.id);
    }
    return frozen;
  }

  async findById(id: string): Promise<PrincipalRecord | null> {
    return this.store.get(id) ?? null;
  }

  async findByTenant(tenantId: string): Promise<PrincipalRecord[]> {
    return [...this.store.values()].filter((p) => p.tenantId === tenantId);
  }

  async findByType(
    type: PrincipalQuery['type'],
    tenantId?: string,
  ): Promise<PrincipalRecord[]> {
    return [...this.store.values()].filter(
      (p) => p.type === type && (tenantId === undefined || p.tenantId === tenantId),
    );
  }

  async findByAgentCard(agentCardId: string): Promise<PrincipalRecord | null> {
    const id = this.byAgentCard.get(agentCardId);
    if (!id) return null;
    return this.store.get(id) ?? null;
  }

  async delete(id: string): Promise<boolean> {
    const existing = this.store.get(id);
    if (!existing) return false;
    if (existing.agentCardId) {
      this.byAgentCard.delete(existing.agentCardId);
    }
    return this.store.delete(id);
  }
}

/**
 * IdentityModule —— 装配 IdentityService / TokenService / OidcProviderService +
 * 默认 PRINCIPAL_REPOSITORY 实现（可被控制面覆盖）。
 *
 * 注意：AGENT_TOKEN_REGISTRY 不在此处提供默认值（沿用 S1 模式）；
 * 控制面 SpiDefaultsModule 提供 InMemoryAgentTokenRegistry 实现。
 */
@Module({
  providers: [
    IdentityService,
    TokenService,
    OidcProviderService,
    {
      provide: PRINCIPAL_REPOSITORY,
      // 默认 InMemoryPrincipalRepository —— 可被控制面 useExisting/useFactory 覆盖
      useFactory: () => new InMemoryPrincipalRepository(),
    },
  ],
  exports: [
    IdentityService,
    TokenService,
    OidcProviderService,
    PRINCIPAL_REPOSITORY,
  ],
})
export class IdentityModule {
  /** 端口令牌常量（同 SpiDefaultsModule 引用模式）。 */
  static readonly PRINCIPAL_REPOSITORY = PRINCIPAL_REPOSITORY;
  static readonly PORTS = { PRINCIPAL_REPOSITORY } as const;
}
