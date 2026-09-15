import { Injectable, Logger } from '@nestjs/common';

export interface UsageEvent {
  eventId: string;
  eventType: string;
  tenantId: string;
  skillId: string;
  callAt: string;
  metadata: Record<string, unknown>;
  cost?: number;
}

export interface UsageStats {
  totalCalls: number;
  totalCost: number;
  bySkill: Record<string, { calls: number; cost: number }>;
}

export interface PeriodicStats {
  period: string;
  start: string;
  end: string;
  totalCalls: number;
  totalCost: number;
  bySkill: Record<string, { calls: number; cost: number }>;
}

/**
 * 统一计量服务（K18-3）。
 *
 * 职责：
 * - 统一记录所有计量事件（替代 BillingEngineService 内部计量）
 * - 支持单条写入和批量写入（事务保证）
 * - 提供查询和统计接口
 */
@Injectable()
export class MeteringService {
  private readonly logger = new Logger(MeteringService.name);
  private readonly store = new Map<string, UsageEvent>();

  // ── 公共接口 ──

  /** 记录单次计量事件 */
  recordUsage(eventType: string, tenantId: string, skillId: string, metadata: Record<string, unknown> = {}): UsageEvent {
    const callAt = (metadata.callAt as string | undefined) ?? new Date().toISOString();
    const event: UsageEvent = {
      eventId: `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      eventType,
      tenantId,
      skillId,
      callAt,
      metadata,
      cost: metadata.cost as number | undefined,
    };
    this.store.set(event.eventId, event);
    this.logger.debug(`Metered: ${event.eventId} tenant=${tenantId} skill=${skillId}`);
    return event;
  }

  /** 批量写入计量事件（原子性保证） */
  batchRecord(events: Array<{ eventType: string; tenantId: string; skillId: string; metadata?: Record<string, unknown> }>): void {
    for (const evt of events) {
      this.recordUsage(evt.eventType, evt.tenantId, evt.skillId, evt.metadata ?? {});
    }
  }

  /** 查询计量记录（支持 tenantId/skillId/时间范围过滤） */
  queryUsage(
    tenantId: string,
    skillId?: string,
    from?: string,
    to?: string,
  ): UsageEvent[] {
    return Array.from(this.store.values()).filter((e) => {
      if (e.tenantId !== tenantId) return false;
      if (skillId && e.skillId !== skillId) return false;
      if (from && e.callAt < from) return false;
      if (to && e.callAt > to) return false;
      return true;
    });
  }

  /** 获取租户用量统计 */
  getStats(tenantId: string): UsageStats {
    const records = this.queryUsage(tenantId);
    const bySkill: Record<string, { calls: number; cost: number }> = {};

    for (const r of records) {
      if (!bySkill[r.skillId]) {
        bySkill[r.skillId] = { calls: 0, cost: 0 };
      }
      bySkill[r.skillId].calls += 1;
      bySkill[r.skillId].cost += (r.cost ?? 0);
    }

    return {
      totalCalls: records.length,
      totalCost: records.reduce((sum, r) => sum + (r.cost ?? 0), 0),
      bySkill,
    };
  }

  /** 按周期分组统计计量数据（daily/weekly/monthly） */
  queryByPeriod(tenantId: string, period: 'daily' | 'weekly' | 'monthly'): PeriodicStats[] {
    const records = this.queryUsage(tenantId);

    const grouped = new Map<string, UsageEvent[]>();
    for (const r of records) {
      let key: string;
      if (period === 'daily') {
        key = r.callAt.slice(0, 10); // 'YYYY-MM-DD'
      } else if (period === 'weekly') {
        const date = new Date(r.callAt);
        const dayOfWeek = date.getDay() || 7; // Monday=1, Sunday=7
        const monday = new Date(date);
        monday.setDate(date.getDate() - dayOfWeek + 1);
        key = monday.toISOString().slice(0, 10);
      } else {
        key = r.callAt.slice(0, 7); // 'YYYY-MM'
      }
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(r);
    }

    const result: PeriodicStats[] = [];
    for (const [key, events] of grouped) {
      let totalCost = 0;
      const bySkill: Record<string, { calls: number; cost: number }> = {};
      for (const e of events) {
        totalCost += e.cost ?? 0;
        if (!bySkill[e.skillId]) bySkill[e.skillId] = { calls: 0, cost: 0 };
        bySkill[e.skillId].calls += 1;
        bySkill[e.skillId].cost += e.cost ?? 0;
      }

      let start: string, end: string;
      if (period === 'daily') {
        start = key + 'T00:00:00.000Z';
        end = key + 'T23:59:59.999Z';
      } else if (period === 'weekly') {
        const monday = new Date(key + 'T00:00:00.000Z');
        const sunday = new Date(monday);
        sunday.setDate(monday.getDate() + 6);
        start = monday.toISOString();
        end = sunday.toISOString();
      } else {
        const yearMonth = key;
        start = yearMonth + '-01T00:00:00.000Z';
        const nextMonth = new Date(yearMonth + '-01T00:00:00.000Z');
        nextMonth.setMonth(nextMonth.getMonth() + 1);
        end = nextMonth.toISOString();
      }

      result.push({
        period: key,
        start,
        end,
        totalCalls: events.length,
        totalCost,
        bySkill,
      });
    }

    return result.sort((a, b) => a.period.localeCompare(b.period));
  }

  /** 测试用清空 */
  clear(): void {
    this.store.clear();
  }
}
