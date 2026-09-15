import { Injectable } from '@nestjs/common';
import type { Run } from '@aegisci/shared/types';
import type { RunRepositoryPort } from '@aegisci/domain/pipeline';

/**
 * InMemoryRunRepository —— Run 仓储端口的内存实现（DES-13 / ADD §7）。
 *
 * 用途：在真实 PG 适配器就绪前，为控制面提供可独立启动的 Run 持久化能力。
 * 接口契约（RunRepositoryPort.load/save）保持与未来 PG 实现互换；
 * 额外方法（loadByRunId / loadByTenant / findByDedupKey）为控制面内部查询便利，
 * 未来 PG 实现应同样提供这些查询能力（或由读模型补足）。
 *
 * 不变式：
 * - 进程重启即清空（内存桩语义，符合 SpiDefaultsModule 既有约定）
 * - 同一 runId 重复 save 为 upsert（覆盖快照）
 */
@Injectable()
export class InMemoryRunRepository implements RunRepositoryPort {
  /** runId → Run 快照（唯一权威存储） */
  private readonly store = new Map<string, Run>();
  /** tenantId → runId[] 反向索引（按租户查询） */
  private readonly byTenant = new Map<string, Set<string>>();
  /** dedupKey → runId（幂等去重索引） */
  private readonly byDedupKey = new Map<string, string>();

  async load(runId: string): Promise<Run | null> {
    const hit = this.store.get(runId);
    return hit ? { ...hit } : null;
  }

  async save(snapshot: Run): Promise<void> {
    // upsert 主存储
    this.store.set(snapshot.runId, { ...snapshot });
    // 维护租户索引
    let bucket = this.byTenant.get(snapshot.tenantId);
    if (!bucket) {
      bucket = new Set<string>();
      this.byTenant.set(snapshot.tenantId, bucket);
    }
    bucket.add(snapshot.runId);
  }

  /** 按 runId 加载（与 load 等价，命名对齐任务契约 loadByRunId） */
  async loadByRunId(runId: string): Promise<Run | null> {
    return this.load(runId);
  }

  /** 按租户加载全部 Run 快照 */
  async loadByTenant(tenantId: string): Promise<Run[]> {
    const ids = this.byTenant.get(tenantId);
    if (!ids) return [];
    const out: Run[] = [];
    for (const id of ids) {
      const snap = this.store.get(id);
      if (snap) out.push({ ...snap });
    }
    return out;
  }

  /**
   * 按幂等键查询已存在的 Run（去重窗口内重复 webhook 命中同一 Run）。
   * 幂等键约定：repo+ref+commit+event_type（由调用方组装）。
   */
  async findByDedupKey(dedupKey: string): Promise<Run | null> {
    const runId = this.byDedupKey.get(dedupKey);
    if (!runId) return null;
    return this.load(runId);
  }

  /**
   * 登记幂等键 → runId 映射。若键已存在则忽略（首创建者获胜）。
   * 由 WebhookController 在创建新 Run 后调用。
   */
  async registerDedupKey(dedupKey: string, runId: string): Promise<boolean> {
    if (this.byDedupKey.has(dedupKey)) return false;
    this.byDedupKey.set(dedupKey, runId);
    return true;
  }

  /** 测试/运维便利：清空全部状态（仅用于测试与本地重启模拟） */
  clear(): void {
    this.store.clear();
    this.byTenant.clear();
    this.byDedupKey.clear();
  }
}
