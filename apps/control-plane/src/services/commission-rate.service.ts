import { Injectable, Logger } from '@nestjs/common';

export interface CommissionRule {
  ruleId: string;
  tenantId: string;
  skillId?: string;
  tier?: 'free' | 'freemium' | 'premium' | 'enterprise';
  certified?: boolean;
  skillType?: 'tool' | 'agent' | 'connector' | 'policy-pack';
  commissionRate: number;  // 0-1，平台抽佣比例
  priority: number;        // 越高越优先
  active: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CommissionCalcResult {
  skillId: string;
  tier: string;
  certified: boolean;
  /** 抽佣比例 */
  commissionRate: number;
  /** 小计金额 */
  subtotal: number;
  /** 平台抽佣金额 */
  platformFee: number;
  /** 分给技能所有者的金额 */
  payout: number;
}

/**
 * 抽佣率配置引擎（K15-2）。
 *
 * 规则优先级：
 * 1. 具体技能规则（skillId 指定）
 * 2. 特定 tier + 认证状态规则
 * 3. 通用 tier 规则
 * 4. 默认规则（standard=20%, certified=10%）
 */
@Injectable()
export class CommissionRateService {
  private readonly logger = new Logger(CommissionRateService.name);

  private readonly rules = new Map<string, CommissionRule[]>();

  /** 默认抽佣率 */
  private static readonly DEFAULT_STANDARD_RATE = 0.20;
  private static readonly DEFAULT_CERTIFIED_RATE = 0.10;

  /** 注册抽佣规则 */
  addRule(rule: CommissionRule): void {
    const tenantRules = this.rules.get(rule.tenantId) ?? [];
    tenantRules.push(rule);
    tenantRules.sort((a, b) => b.priority - a.priority);
    this.rules.set(rule.tenantId, tenantRules);
    this.logger.log(`Commission rule added: ${rule.ruleId}, rate=${rule.commissionRate}, priority=${rule.priority}`);
  }

  /** 获取租户所有规则 */
  getRules(tenantId: string): CommissionRule[] {
    return this.rules.get(tenantId) ?? [];
  }

  /**
   * 计算指定技能的抽佣率。
   * 按优先级匹配规则，返回第一个激活的规则。
   */
  calcCommissionRate(
    tenantId: string,
    skillId: string,
    tier: string,
    certified: boolean,
    skillType: string,
  ): number {
    const allRules = this.rules.get(tenantId) ?? [];
    const activeRules = allRules.filter((r) => r.active);

    // 按优先级从高到低查找匹配规则
    for (const rule of activeRules) {
      if (this._matches(rule, skillId, tier, certified, skillType)) {
        return rule.commissionRate;
      }
    }

    // 未匹配：返回默认值
    return certified ? CommissionRateService.DEFAULT_CERTIFIED_RATE : CommissionRateService.DEFAULT_STANDARD_RATE;
  }

  /** 计算抽佣结果 */
  calcCommission(
    tenantId: string,
    skillId: string,
    subtotal: number,
    tier: string,
    certified: boolean,
    skillType: string,
  ): CommissionCalcResult | null {
    if (tier === 'free') return null;
    const rate = this.calcCommissionRate(tenantId, skillId, tier, certified, skillType);
    const platformFee = parseFloat((subtotal * rate).toFixed(6));
    const payout = parseFloat((subtotal - platformFee).toFixed(6));
    return { skillId, tier, certified, commissionRate: rate, subtotal, platformFee, payout };
  }

  /** 删除规则 */
  removeRule(tenantId: string, ruleId: string): boolean {
    const tenantRules = this.rules.get(tenantId) ?? [];
    const idx = tenantRules.findIndex((r) => r.ruleId === ruleId);
    if (idx === -1) return false;
    tenantRules.splice(idx, 1);
    this.rules.set(tenantId, tenantRules);
    return true;
  }

  /** 测试用清空 */
  clear(): void {
    this.rules.clear();
  }

  // ── 私有辅助 ──

  private _matches(rule: CommissionRule, skillId: string, tier: string, certified: boolean, skillType: string): boolean {
    if (rule.skillId && rule.skillId !== skillId) return false;
    if (rule.tier && rule.tier !== '*' && rule.tier !== tier) return false;
    if (rule.certified !== undefined && rule.certified !== certified) return false;
    if (rule.skillType && rule.skillType !== skillType) return false;
    return true;
  }
}
