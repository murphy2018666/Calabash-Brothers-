import { Injectable, Logger } from '@nestjs/common';
import { type MonthlyBill } from '@aegisci/shared/types';
import { RefundRecord, RefundQuery, RefundResponse, RefundStatus } from '@aegisci/shared/types';

/**
 * 退款管理服务（K12-3）。
 *
 * 退款类型：
 * - standard_refund：7 天无理由，自动通过
 * - disputed_refund：争议退款，需人工审批
 *
 * 状态机：pending → approved → processed / cancelled / disputed
 */
@Injectable()
export class RefundService {
  private readonly logger = new Logger(RefundService.name);

  private readonly store = new Map<string, RefundRecord>();
  /** 7 天无理由退款时限（毫秒） */
  private readonly REFUND_WINDOW_MS = 7 * 86400000;

  // ── 公共接口 ──

  /** 申请退款 */
  requestRefund(billId: string, tenantId: string, skillId: string, amount: number, reason: string): RefundRecord {
    const now = new Date().toISOString();
    const record: RefundRecord = {
      refundId: `refund-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      billId,
      tenantId,
      skillId,
      amount,
      reason,
      status: 'pending',
      appliedAt: now,
    };
    this.store.set(record.refundId, record);
    this.logger.log(`Refund requested: ${record.refundId} for bill=${billId} amount=${amount}`);
    return record;
  }

  /** 审批退款 */
  approveRefund(refundId: string): RefundRecord {
    const record = this.assertRecord(refundId);
    if (record.status !== 'pending') {
      throw new Error(`Cannot approve refund with status '${record.status}'`);
    }
    const now = new Date().toISOString();
    record.status = 'approved';
    record.approvedAt = now;
    this.store.set(refundId, record);
    this.logger.log(`Refund approved: ${refundId}`);
    return record;
  }

  /** 执行退款（标记为已处理） */
  processRefund(refundId: string): RefundRecord {
    const record = this.assertRecord(refundId);
    if (record.status !== 'approved') {
      throw new Error(`Cannot process refund with status '${record.status}'`);
    }
    const now = new Date().toISOString();
    record.status = 'processed';
    record.processedAt = now;
    this.store.set(refundId, record);
    this.logger.log(`Refund processed: ${refundId} amount=${record.amount}`);
    return record;
  }

  /** 取消退款 */
  cancelRefund(refundId: string): RefundRecord {
    const record = this.assertRecord(refundId);
    if (record.status !== 'pending' && record.status !== 'approved') {
      throw new Error(`Cannot cancel refund with status '${record.status}'`);
    }
    const now = new Date().toISOString();
    record.status = 'cancelled';
    record.cancelledAt = now;
    this.store.set(refundId, record);
    this.logger.log(`Refund cancelled: ${refundId}`);
    return record;
  }

  /** 标记为争议 */
  disputeRefund(refundId: string): RefundRecord {
    const record = this.assertRecord(refundId);
    const now = new Date().toISOString();
    record.status = 'disputed';
    record.auditTrail?.push({ action: 'disputed', actor: 'system', timestamp: now, note: record.reason });
    this.store.set(refundId, record);
    this.logger.warn(`Refund disputed: ${refundId}`);
    return record;
  }

  /** 查询退款详情 */
  getRefund(refundId: string, tenantId?: string): RefundRecord {
    const record = this.store.get(refundId);
    if (!record) throw new Error(`Refund not found: ${refundId}`);
    if (tenantId && record.tenantId !== tenantId) {
      throw new Error('Permission denied: tenant mismatch');
    }
    return record;
  }

  /** 分页查询退款记录 */
  listRefunds(query: RefundQuery): RefundResponse {
    let records = Array.from(this.store.values()).filter((r) => r.tenantId === query.tenantId);
    if (query.billId) {
      records = records.filter((r) => r.billId === query.billId);
    }
    if (query.skillId) {
      records = records.filter((r) => r.skillId === query.skillId);
    }
    if (query.status) {
      records = records.filter((r) => r.status === query.status);
    }

    const total = records.length;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    return {
      refunds: records.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    };
  }

  /** 判断是否在 7 天无理由退款窗口内 */
  isWithin7Days(billCreatedAt: string): boolean {
    const billDate = new Date(billCreatedAt);
    const now = new Date();
    const diffMs = now.getTime() - billDate.getTime();
    return diffMs <= this.REFUND_WINDOW_MS;
  }

  /** 根据账单自动判断是否可无理由退款 */
  canAutoApprove(billCreatedAt: string): boolean {
    return this.isWithin7Days(billCreatedAt);
  }

  /** 清空存储（测试用） */
  clear(): void {
    this.store.clear();
  }

  // ── 私有辅助 ──

  private assertRecord(refundId: string): RefundRecord {
    const record = this.store.get(refundId);
    if (!record) throw new Error(`Refund not found: ${refundId}`);
    return record;
  }
}
