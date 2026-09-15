import { Injectable } from '@nestjs/common';

export interface FreemiumQuota {
  skillId: string;
  tenantId: string;
  quota: number;
  used: number;
  remaining: number;
  exceeded: boolean;
}

/**
 * 免费/Freemium 定价模型服务（K15-1）。
 *
 * 核心逻辑：
 * - free tier：不调用计费引擎，记录 metering 但 cost = 0
 * - freemium tier：基础配额内 cost = 0，超量后按超量单价计费
 * - subscription / usage：透传现有计费逻辑
 */
@Injectable()
export class PricingModelService {
  /**
   * 计算本次调用的费用。
   * @param tenantId 租户 ID
   * @param skillId 技能 ID
   * @param tier 定价档位
   * @param overagePrice 超量单价（freemium 超配额时）
   * @param monthlyQuota 月度配额（freemium 档位）
   * @param callsUsed 本月已用调用次数
   */
  calcCost(
    tenantId: string,
    skillId: string,
    tier: 'free' | 'freemium' | 'subscription' | 'usage',
    overagePrice: number,
    monthlyQuota: number,
    callsUsed: number,
  ): number {
    if (tier === 'free') {
      return 0;
    }
    if (tier === 'freemium') {
      if (callsUsed < monthlyQuota) {
        // 配额内免费
        return 0;
      }
      // 超出配额，按超量单价计费
      return overagePrice;
    }
    // subscription / usage：由 BillingEngineService 处理
    return -1;
  }

  /**
   * 检查 freemium 技能是否仍有配额。
   */
  hasQuota(tenantId: string, skillId: string, monthlyQuota: number, callsUsed: number, tier?: string): boolean {
    if (tier === 'free') return true;
    return callsUsed < monthlyQuota;
  }

  /**
   * 获取配额信息。
   */
  getQuotaInfo(tenantId: string, skillId: string, monthlyQuota: number, callsUsed: number): FreemiumQuota {
    return {
      skillId,
      tenantId,
      quota: monthlyQuota,
      used: callsUsed,
      remaining: Math.max(0, monthlyQuota - callsUsed),
      exceeded: callsUsed >= monthlyQuota,
    };
  }

  /**
   * 测试用清空方法。
   */
  clear(): void {
    // 无状态服务，无需清理
  }
}
