/**
 * 计量计费引擎类型定义（K10，V2.0 技能市场计费子域）。
 *
 * 四档定价模型：free / freemium / subscription / usage
 * 核心实体：MeteringRecord、MonthlyBill、BillLineItem
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 定价档位
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type PricingTier = 'free' | 'freemium' | 'subscription' | 'usage';

export interface PricingModel {
  /** 定价档位 */
  tier: PricingTier;
  /** 月固定费用（subscription 档必填） */
  baseFee?: number;
  /** 单次调用价格（usage 档必填；freemium 超量后使用） */
  perCallPrice?: number;
  /** 月度调用限额（freemium / subscription 档使用） */
  monthlyQuota?: number;
  /** 超量单价（subscription 档超 quota 后使用） */
  overagePrice?: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 计量记录
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface MeteringRecord {
  recordId: string;
  tenantId: string;
  skillId: string;
  callAt: string;
  durationMs: number;
  /** 本次调用费用（由计费引擎计算，可为 undefined 表示未结算） */
  cost?: number;
  /** 调用类型：tool / agent / connector */
  usageType: string;
  evidenceId: string;
  traceSpanId: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 月度账单
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type BillStatus = 'draft' | 'finalized' | 'paid';

export interface MonthlyBill {
  billId: string;
  tenantId: string;
  /** yyyy-MM 格式 */
  period: string;
  totalCalls: number;
  totalCost: number;
  lineItems: BillLineItem[];
  status: BillStatus;
  createdAt: string;
  finalizedAt?: string;
}

export interface BillLineItem {
  skillId: string;
  name: string;
  calls: number;
  unitPrice: number;
  subtotal: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 响应类型
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface MeteringQuery {
  tenantId: string;
  skillId?: string;
  from?: string;
  to?: string;
  page?: number;
  pageSize?: number;
}

export interface MeteringResponse {
  records: MeteringRecord[];
  total: number;
  page: number;
  pageSize: number;
  totalCost: number;
}

export interface BillingStats {
  tenantId: string;
  totalCalls: number;
  totalCost: number;
  currentMonthCalls: number;
  currentMonthCost: number;
  topSkills: { skillId: string; calls: number; cost: number }[];
}
