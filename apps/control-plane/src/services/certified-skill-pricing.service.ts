import { Injectable, Logger } from '@nestjs/common';

export type PricingPeriod = 'monthly' | 'yearly' | 'perpetual';

export interface PricingPlan {
  planId: string;
  skillId: string;
  tenantId: string;
  period: PricingPeriod;
  price: number;
  status: 'active' | 'draft' | 'archived';
  createdAt: string;
  updatedAt: string;
}

/**
 * 认证付费技能定价服务（K18-1）。
 *
 * 职责：
 * - 管理付费技能的定价计划（创建/查询/更新/删除）
 * - 支持月度/年度/永久三种计费周期
 * - 租户隔离：每个租户的技能定价独立存储
 */
@Injectable()
export class CertifiedSkillPricingService {
  private readonly logger = new Logger(CertifiedSkillPricingService.name);
  private readonly store = new Map<string, PricingPlan>();

  // ── 公共接口 ──

  /** 创建付费定价计划 */
  createPricingPlan(skillId: string, tenantId: string, period: PricingPeriod, price: number): PricingPlan {
    if (price <= 0) {
      throw new Error(`Price must be > 0, got ${price}`);
    }
    if (!['monthly', 'yearly', 'perpetual'].includes(period)) {
      throw new Error(`Invalid period: ${period}. Must be monthly/yearly/perpetual`);
    }

    // 同一技能+租户只能有一个活跃定价计划
    for (const plan of this.store.values()) {
      if (plan.skillId === skillId && plan.tenantId === tenantId && plan.status === 'active') {
        throw new Error(`Active pricing plan already exists for skill=${skillId}, tenant=${tenantId}`);
      }
    }

    const now = new Date().toISOString();
    const plan: PricingPlan = {
      planId: `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      skillId,
      tenantId,
      period,
      price,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    };
    this.store.set(plan.planId, plan);
    this.logger.log(`Pricing plan created: ${plan.planId} for skill=${skillId}`);
    return plan;
  }

  /** 查询指定技能+租户的定价计划 */
  getPricingPlan(skillId: string, tenantId: string): PricingPlan | undefined {
    for (const plan of this.store.values()) {
      if (plan.skillId === skillId && plan.tenantId === tenantId && plan.status === 'active') {
        return plan;
      }
    }
    return undefined;
  }

  /** 更新定价计划 */
  updatePricingPlan(planId: string, updates: Partial<PricingPlan>): PricingPlan | null {
    const plan = this.store.get(planId);
    if (!plan) return null;

    if (updates.price !== undefined && updates.price <= 0) {
      throw new Error(`Price must be > 0, got ${updates.price}`);
    }

    Object.assign(plan, updates, { updatedAt: new Date().toISOString() });
    this.logger.log(`Pricing plan updated: ${planId}`);
    return plan;
  }

  /** 下架/归档定价计划 */
  deletePricingPlan(planId: string, tenantId: string): boolean {
    const plan = this.store.get(planId);
    if (!plan || plan.tenantId !== tenantId) return false;

    plan.status = 'archived';
    plan.updatedAt = new Date().toISOString();
    this.logger.log(`Pricing plan archived: ${planId}`);
    return true;
  }

  /** 查询租户所有定价计划 */
  listPricingPlans(tenantId: string): PricingPlan[] {
    return Array.from(this.store.values()).filter(
      (p) => p.tenantId === tenantId && p.status === 'active',
    );
  }

  /** 测试用清空 */
  clear(): void {
    this.store.clear();
  }
}
