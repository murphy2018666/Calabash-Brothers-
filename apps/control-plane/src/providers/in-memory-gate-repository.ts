import { Injectable } from '@nestjs/common';
import type { GateRecord, GateRepositoryPort } from '@aegisci/domain/pipeline';

/**
 * InMemoryGateRepository —— Gate 仓储端口的内存实现（D2-4）。
 *
 * 用途：为 GateAggregate HITL 审批链路提供可独立运行的持久化能力。
 * 进程重启即清空，符合 SpiDefaultsModule 约定。
 */
@Injectable()
export class InMemoryGateRepository implements GateRepositoryPort {
  private readonly store = new Map<string, GateRecord>();

  async load(gateId: string): Promise<GateRecord | null> {
    return this.store.get(gateId) ?? null;
  }

  async save(snapshot: GateRecord): Promise<void> {
    this.store.set(snapshot.gateId, { ...snapshot });
  }

  /** 测试/运维便利：清空全部状态 */
  clear(): void {
    this.store.clear();
  }
}
