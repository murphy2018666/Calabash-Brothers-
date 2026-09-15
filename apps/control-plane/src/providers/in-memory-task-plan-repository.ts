import { Injectable, Logger } from '@nestjs/common';
import type { TaskPlan } from '@aegisci/domain/orchestration';
import type { TaskPlanRepository } from '@aegisci/domain/orchestration';

/**
 * InMemoryTaskPlanRepository —— TaskPlan 仓储端口的内存实现（D2-2 / S3 骨架档位）。
 *
 * 用途：在真实 PG 适配器就绪前，为 AgentDispatcherService 提供可独立启动的 TaskPlan
 * 持久化能力。接口契约（load/save/loadByRun）与未来 PG 实现互换；进程重启即清空。
 *
 * 不变式：
 * - 进程重启即清空（内存桩语义，符合 S3 骨架档位约定）
 * - 同一 taskPlanId 重复 save 为 upsert（覆盖快照）
 * - loadByRun 走 taskPlanId 后缀匹配（taskPlanId 约定为 `${runId}_tp_${n}`）
 */
@Injectable()
export class InMemoryTaskPlanRepository implements TaskPlanRepository {
  private readonly logger = new Logger(InMemoryTaskPlanRepository.name);
  private readonly store = new Map<string, TaskPlan>();

  async save(plan: TaskPlan): Promise<void> {
    this.store.set(plan.taskPlanId, plan);
    this.logger.debug(
      `saved TaskPlan ${plan.taskPlanId} (run=${plan.runId}, state=${plan.state})`,
    );
  }

  async load(taskPlanId: string): Promise<TaskPlan | null> {
    const hit = this.store.get(taskPlanId);
    return hit ?? null;
  }

  /**
   * 按 runId 加载 TaskPlan（OR 域约定：taskPlanId 后缀含 runId）。
   * 若存在多个匹配则返回最新保存的那个（取最大值）。
   */
  async loadByRun(runId: string): Promise<TaskPlan | null> {
    const matches: TaskPlan[] = [];
    for (const plan of this.store.values()) {
      if (plan.runId === runId) matches.push(plan);
    }
    if (matches.length === 0) return null;
    // 返回最新的（以 taskPlanId 字符串排序）
    matches.sort((a, b) => a.taskPlanId.localeCompare(b.taskPlanId));
    return matches[matches.length - 1];
  }

  /** 测试/运维便利：清空全部状态（仅用于测试与本地重启模拟） */
  clear(): void {
    this.store.clear();
  }
}
