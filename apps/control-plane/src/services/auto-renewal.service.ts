import { Injectable, Logger } from '@nestjs/common';
import { CertifiedSkillPricingService, type PricingPlan } from './certified-skill-pricing.service';

export type RenewalStatus = 'scheduled' | 'processed' | 'cancelled';
export type BillingPeriod = 'monthly' | 'yearly' | 'perpetual';

export interface AutoRenewalConfig {
  configId: string;
  planId: string;
  tenantId: string;
  skillId: string;
  nextBillingDate: string;
  gracePeriodDays: number;
  autoRenew: boolean;
  status: RenewalStatus;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class AutoRenewalService {
  private readonly logger = new Logger(AutoRenewalService.name);
  private readonly store = new Map<string, AutoRenewalConfig>();

  constructor(private readonly pricingService: CertifiedSkillPricingService) {}

  /** 登记续约任务 */
  scheduleRenewal(
    planId: string,
    tenantId: string,
    skillId: string,
    nextBillingDate: string,
    gracePeriodDays: number = 7,
  ): AutoRenewalConfig {
    // 幂等：同一 planId+tenantId 已有 scheduled 记录则更新，不重复创建
    const existing = this.findScheduled(planId, tenantId);
    if (existing) {
      return this.updateRenewal(existing.configId, { nextBillingDate, gracePeriodDays });
    }

    const now = new Date().toISOString();
    const config: AutoRenewalConfig = {
      configId: `renew-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      planId,
      tenantId,
      skillId,
      nextBillingDate,
      gracePeriodDays,
      autoRenew: true,
      status: 'scheduled',
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(config.configId, config);
    this.logger.log(`Renewal scheduled: ${config.configId} for plan=${planId}`);
    return config;
  }

  /** 处理所有到期续约任务 */
  processRenewals(cutoffDate?: string): ProcessedRenewalResult[] {
    const now = cutoffDate ?? new Date().toISOString();
    const results: ProcessedRenewalResult[] = [];

    for (const config of this.store.values()) {
      if (config.status !== 'scheduled') continue;
      if (config.nextBillingDate > now) continue;

      results.push(this._processSingle(config));
    }

    return results;
  }

  /** 查询即将到期的续约（支持时间范围过滤） */
  getUpcomingRenewals(tenantId?: string, hoursAhead?: number): AutoRenewalConfig[] {
    const now = new Date().toISOString();
    const cutoff = hoursAhead ? new Date(Date.now() + hoursAhead * 3600000).toISOString() : undefined;

    return Array.from(this.store.values()).filter((c) => {
      if (c.status !== 'scheduled') return false;
      if (tenantId && c.tenantId !== tenantId) return false;
      if (cutoff && c.nextBillingDate > cutoff) return false;
      // 只显示未来或刚到期的
      return c.nextBillingDate <= now;
    });
  }

  /** 取消续约 */
  cancelRenewal(planId: string, tenantId: string): boolean {
    const config = this.findScheduled(planId, tenantId);
    if (!config) return false;

    config.status = 'cancelled';
    config.updatedAt = new Date().toISOString();
    this.store.set(config.configId, config);
    this.logger.log(`Renewal cancelled: ${config.configId}`);
    return true;
  }

  /** 清空存储（测试用） */
  clear(): void {
    this.store.clear();
  }

  // ── 私有辅助 ──

  private _processSingle(config: AutoRenewalConfig): ProcessedRenewalResult {
    const graceEnd = new Date(Date.parse(config.nextBillingDate) + config.gracePeriodDays * 86400000).toISOString();
    const now = new Date().toISOString();

    // 检查是否已超宽限期
    if (now > graceEnd) {
      config.status = 'cancelled';
      config.updatedAt = now;
      this.store.set(config.configId, config);
      this.logger.warn(`Renewal grace period expired: ${config.configId}`);
      return { configId: config.configId, planId: config.planId, status: 'grace_expired' as const };
    }

    // 续约成功：更新 PricingPlan 的 updatedAt
    const plan = this.pricingService.getPricingPlan(config.skillId, config.tenantId);
    if (!plan) {
      config.status = 'cancelled';
      config.updatedAt = now;
      this.store.set(config.configId, config);
      return { configId: config.configId, planId: config.planId, status: 'no_pricing_plan' as const };
    }

    // 计算下次到期日
    const newNextBillingDate = this._calcNextBillingDate(config.nextBillingDate, plan.period);
    const updatedPlan = this.pricingService.updatePricingPlan(plan.planId, {
      updatedAt: now,
    });

    config.status = 'processed';
    config.nextBillingDate = newNextBillingDate;
    config.updatedAt = now;
    this.store.set(config.configId, config);
    this.logger.log(`Renewal processed: ${config.configId} → next=${newNextBillingDate}`);

    return {
      configId: config.configId,
      planId: config.planId,
      status: 'renewed' as const,
      newNextBillingDate,
      planUpdated: !!updatedPlan,
    };
  }

  private _calcNextBillingDate(currentDate: string, period: string): string {
    const date = new Date(currentDate);
    if (period === 'monthly') {
      date.setMonth(date.getMonth() + 1);
    } else if (period === 'yearly') {
      date.setFullYear(date.getFullYear() + 1);
    }
    // perpetual 不需要续约
    return date.toISOString();
  }

  private findScheduled(planId: string, tenantId: string): AutoRenewalConfig | undefined {
    for (const c of this.store.values()) {
      if (c.planId === planId && c.tenantId === tenantId && c.status === 'scheduled') {
        return c;
      }
    }
    return undefined;
  }

  private updateRenewal(configId: string, updates: Partial<AutoRenewalConfig>): AutoRenewalConfig {
    const config = this.store.get(configId);
    if (!config) throw new Error(`Renewal config not found: ${configId}`);
    Object.assign(config, updates, { updatedAt: new Date().toISOString() });
    this.store.set(configId, config);
    return config;
  }
}

export interface ProcessedRenewalResult {
  configId: string;
  planId: string;
  status: 'renewed' | 'grace_expired' | 'no_pricing_plan';
  newNextBillingDate?: string;
  planUpdated?: boolean;
}
