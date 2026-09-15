/**
 * 官方认证体系类型定义（K12，V2.0 技能市场认证子域）。
 *
 * 认证流程状态机：
 *   pending → reviewing → approved → expired / suspended
 *                            ↘ rejected
 *
 * 退款流程状态机：
 *   pending → approved → processed / cancelled / disputed
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 认证审核状态
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type CertificationStatus = 'pending' | 'reviewing' | 'approved' | 'rejected' | 'suspended';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 审计轨迹
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AuditEntry {
  action: string;
  actor: string;
  timestamp: string;
  note?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 认证记录
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface CertificationRecord {
  certificationId: string;
  skillId: string;
  tenantId: string;
  status: CertificationStatus;
  appliedAt: string;
  reviewedAt?: string;
  reviewerId?: string;
  reviewNote?: string;
  certifiedAt?: string;
  validUntil: string; // 有效期（一年）
  auditTrail: AuditEntry[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// API 请求/响应
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface CertificationQuery {
  tenantId: string;
  skillId?: string;
  status?: CertificationStatus;
  page?: number;
  pageSize?: number;
}

export interface CertificationResponse {
  records: CertificationRecord[];
  total: number;
  page: number;
  pageSize: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 退款状态
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type RefundStatus = 'pending' | 'approved' | 'processed' | 'cancelled' | 'disputed';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 退款记录
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface RefundRecord {
  refundId: string;
  billId: string;
  tenantId: string;
  skillId: string;
  amount: number;
  reason: string;
  status: RefundStatus;
  appliedAt: string;
  approvedAt?: string;
  processedAt?: string;
  cancelledAt?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 退款查询
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface RefundQuery {
  tenantId: string;
  billId?: string;
  skillId?: string;
  status?: RefundStatus;
  page?: number;
  pageSize?: number;
}

export interface RefundResponse {
  refunds: RefundRecord[];
  total: number;
  page: number;
  pageSize: number;
}
