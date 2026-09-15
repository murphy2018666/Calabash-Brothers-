/**
 * 分账结算类型定义（K11，V2.0 技能市场结算子域）。
 *
 * 支持两种分账比例：
 * - standard: 80/20（技能所有者 80%，平台方 20%）
 * - certified: 90/10（认证技能所有者 90%，平台方 10%）
 *
 * 结算生命周期：pending → approved → paid
 * 最低起付线：¥100（未达 ¥100 不进入 approved）
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 分账比例
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type SplitRatio = 'standard' | 'certified';

export interface SplitModel {
  /** 分账比例 */
  ratio: SplitRatio;
  /** 技能所有者占比（80 或 90） */
  skillOwnerPct: number;
  /** 平台方占比（20 或 10） */
  platformPct: number;
  /** 认证时间（certified 档必填） */
  certifiedAt?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 分账记录
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SplitRecord {
  recordId: string;
  billId: string;
  tenantId: string;
  skillId: string;
  /** 订单收入（来自 MonthlyBill.lineItems.subtotal） */
  revenue: number;
  /** 分账比例 */
  splitRatio: SplitRatio;
  /** 应分给技能所有者的金额（revenue × skillOwnerPct / 100） */
  skillOwnerAmount: number;
  /** 平台方留存金额（revenue × platformPct / 100） */
  platformAmount: number;
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 结算
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type SettlementStatus = 'pending' | 'approved' | 'paid' | 'disputed';

export interface Settlement {
  settlementId: string;
  tenantId: string;
  /** yyyy-MM 格式 */
  period: string;
  totalRevenue: number;
  totalSkillOwnerPayout: number;
  totalPlatformRevenue: number;
  splitRecords: SplitRecord[];
  status: SettlementStatus;
  /** 审批时间 */
  approvedAt?: string;
  /** 支付时间 */
  paidAt?: string;
  /** 发票信息（对公发票预留） */
  invoiceNumber?: string;
  invoiceType?: string;
  createdAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 请求/响应类型
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SettlementQuery {
  tenantId: string;
  period?: string;
  status?: SettlementStatus;
  page?: number;
  pageSize?: number;
}

export interface SettlementResponse {
  settlements: Settlement[];
  total: number;
  page: number;
  pageSize: number;
}

export interface SettlementStats {
  tenantId: string;
  totalRevenue: number;
  totalPayout: number;
  totalPlatformRevenue: number;
  pendingCount: number;
  approvedCount: number;
  paidCount: number;
}
