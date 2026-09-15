import { Injectable, Logger } from '@nestjs/common';
import {
  type PrincipalRepository,
  type PrincipalRecord,
  type PrincipalQuery,
} from '@aegisci/domain/identity';

/**
 * InMemoryPrincipalRepository —— 控制面 S2 默认主体持久化实现（生产候选档）。
 *
 * 与 IdentityModule 内置 InMemoryPrincipalRepository 区别：
 * - 显式 @Injectable（可由 SpiDefaultsModule 装配覆盖 IdentityModule 内置默认）
 * - 多索引（id / agentCardId / tenant+type）以加速检索
 * - 健康检查钩子（healthy()）
 * - 详细日志（register/delete/update）
 *
 * 不变量（同端口契约）：
 * - read-your-writes：save() 后 findById() 必命中
 * - 跨租户隔离：findByType(type, tenantId) 必须显式带 tenantId 才返回结果
 * - 写入冻结：Object.freeze(record) 防止外部可变修改
 *
 * 进程重启即清空（S2 骨架档位，S3+ 切换 PG 实现替换此类）。
 */
@Injectable()
export class InMemoryPrincipalRepository implements PrincipalRepository {
  private readonly logger = new Logger(InMemoryPrincipalRepository.name);
  private readonly store = new Map<string, PrincipalRecord>();
  /** agentCardId → principalId 反向索引（仅 type='agent' 主体有）。 */
  private readonly byAgentCard = new Map<string, string>();
  /** tenantId|type → principalId 集合索引（按租户+类型快速检索）。 */
  private readonly byTenantType = new Map<string, Set<string>>();

  async save(record: PrincipalRecord): Promise<PrincipalRecord> {
    const frozen: PrincipalRecord = Object.freeze({ ...record });
    const existing = this.store.get(record.id);
    if (existing?.agentCardId) {
      // 旧 agentCardId 已变更（罕见）→ 清旧索引
      this.byAgentCard.delete(existing.agentCardId);
    }
    this.store.set(record.id, frozen);
    if (record.agentCardId) {
      this.byAgentCard.set(record.agentCardId, record.id);
    }
    this.indexTenantType(record);
    this.logger.debug(
      `saved principal ${record.id} (type=${record.type}, tenant=${record.tenantId})`,
    );
    return frozen;
  }

  async findById(id: string): Promise<PrincipalRecord | null> {
    return this.store.get(id) ?? null;
  }

  async findByTenant(tenantId: string): Promise<PrincipalRecord[]> {
    const out: PrincipalRecord[] = [];
    for (const record of this.store.values()) {
      if (record.tenantId === tenantId) out.push(record);
    }
    return out;
  }

  async findByType(
    type: PrincipalQuery['type'],
    tenantId?: string,
  ): Promise<PrincipalRecord[]> {
    // tenant+type 索引命中时走快路径；否则扫描全表
    if (tenantId !== undefined) {
      const key = this.tenantTypeKey(tenantId, type);
      const ids = this.byTenantType.get(key);
      if (!ids) return [];
      const out: PrincipalRecord[] = [];
      for (const id of ids) {
        const rec = this.store.get(id);
        if (rec) out.push(rec);
      }
      return out;
    }
    return [...this.store.values()].filter((r) => r.type === type);
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
    this.unindexTenantType(existing);
    const deleted = this.store.delete(id);
    this.logger.debug(
      `deleted principal ${id} (existed=${deleted}, type=${existing.type})`,
    );
    return deleted;
  }

  /** 健康检查（生产应连接 PG 健康探针；S2 内存桩恒 true）。 */
  async healthy(): Promise<boolean> {
    return true;
  }

  /** 清空（仅测试用；生产不可调用）。 */
  clear(): void {
    this.store.clear();
    this.byAgentCard.clear();
    this.byTenantType.clear();
  }

  /** 当前主体总数（仅测试用）。 */
  size(): number {
    return this.store.size;
  }

  private indexTenantType(record: PrincipalRecord): void {
    const key = this.tenantTypeKey(record.tenantId, record.type);
    let set = this.byTenantType.get(key);
    if (!set) {
      set = new Set();
      this.byTenantType.set(key, set);
    }
    set.add(record.id);
  }

  private unindexTenantType(record: PrincipalRecord): void {
    const key = this.tenantTypeKey(record.tenantId, record.type);
    const set = this.byTenantType.get(key);
    if (set) {
      set.delete(record.id);
      if (set.size === 0) this.byTenantType.delete(key);
    }
  }

  private tenantTypeKey(tenantId: string, type: PrincipalQuery['type']): string {
    return `${tenantId}|${type}`;
  }
}
