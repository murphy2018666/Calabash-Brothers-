import { Injectable, Logger } from '@nestjs/common';
import {
  CertificationRecord,
  CertificationQuery,
  CertificationResponse,
  CertificationStatus,
} from '@aegisci/shared/types';

/**
 * 认证引擎核心 Service（K12-1）。
 *
 * 状态机：
 *   pending → reviewing → approved → expired / suspended
 *                            ↘ rejected
 */
@Injectable()
export class CertificationEngineService {
  private readonly logger = new Logger(CertificationEngineService.name);

  private readonly store = new Map<string, CertificationRecord>();
  private readonly CERTIFIED_PERIOD_DAYS = 365;

  // ── 公共接口 ──

  /** 申请技能认证 */
  applyCertification(skillId: string, tenantId: string): CertificationRecord {
    const now = new Date().toISOString();
    const validUntil = new Date(Date.now() + this.CERTIFIED_PERIOD_DAYS * 86400000).toISOString();
    const record: CertificationRecord = {
      certificationId: `cert-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      skillId,
      tenantId,
      status: 'pending',
      appliedAt: now,
      validUntil,
      auditTrail: [{ action: 'applied', actor: tenantId, timestamp: now, note: ' Certification application submitted' }],
    };
    this.store.set(record.certificationId, record);
    this.logger.log(`Certification applied: ${record.certificationId} for skill=${skillId}`);
    return record;
  }

  /** 审核认证（通过或拒绝） */
  reviewCertification(certificationId: string, approved: boolean, reviewerId: string, note?: string): CertificationRecord {
    const record = this.assertRecord(certificationId);
    if (record.status !== 'pending' && record.status !== 'reviewing') {
      throw new Error(`Cannot review certification with status '${record.status}'`);
    }
    const now = new Date().toISOString();
    record.status = approved ? 'approved' : 'rejected';
    record.reviewedAt = now;
    record.reviewerId = reviewerId;
    record.reviewNote = note;
    record.auditTrail.push({
      action: approved ? 'approved' : 'rejected',
      actor: reviewerId,
      timestamp: now,
      note,
    });
    if (approved) {
      record.certifiedAt = now;
    }
    this.store.set(certificationId, record);
    this.logger.log(`Certification ${approved ? 'approved' : 'rejected'}: ${certificationId} by ${reviewerId}`);
    return record;
  }

  /** 将认证状态置为 reviewing（人工审核前） */
  startReview(certificationId: string): CertificationRecord {
    const record = this.assertRecord(certificationId);
    if (record.status !== 'pending') {
      throw new Error(`Cannot start review for certification with status '${record.status}'`);
    }
    const now = new Date().toISOString();
    record.status = 'reviewing';
    record.auditTrail.push({ action: 'review_started', actor: 'system', timestamp: now });
    this.store.set(certificationId, record);
    return record;
  }

  /** 暂停认证（争议期间） */
  suspendCertification(certificationId: string, reason?: string): CertificationRecord {
    const record = this.assertRecord(certificationId);
    if (record.status !== 'approved') {
      throw new Error(`Cannot suspend certification with status '${record.status}'`);
    }
    const now = new Date().toISOString();
    record.status = 'suspended';
    record.auditTrail.push({ action: 'suspended', actor: 'system', timestamp: now, note: reason });
    this.store.set(certificationId, record);
    this.logger.warn(`Certification suspended: ${certificationId} — ${reason ?? 'no reason provided'}`);
    return record;
  }

  /** 恢复已暂停的认证 */
  resumeCertification(certificationId: string): CertificationRecord {
    const record = this.assertRecord(certificationId);
    if (record.status !== 'suspended') {
      throw new Error(`Cannot resume certification with status '${record.status}'`);
    }
    const now = new Date().toISOString();
    record.status = 'approved';
    record.auditTrail.push({ action: 'resumed', actor: 'system', timestamp: now });
    this.store.set(certificationId, record);
    return record;
  }

  /** 查询认证详情 */
  getCertification(certificationId: string, tenantId?: string): CertificationRecord {
    const record = this.store.get(certificationId);
    if (!record) throw new Error(`Certification not found: ${certificationId}`);
    if (tenantId && record.tenantId !== tenantId) {
      throw new Error('Permission denied: tenant mismatch');
    }
    return record;
  }

  /** 分页查询认证记录 */
  listCertifications(query: CertificationQuery): CertificationResponse {
    let records = Array.from(this.store.values()).filter((r) => r.tenantId === query.tenantId);
    if (query.skillId) {
      records = records.filter((r) => r.skillId === query.skillId);
    }
    if (query.status) {
      records = records.filter((r) => r.status === query.status);
    }
    // 过滤过期记录（不在返回列表中，但保留在 store 中）
    const now = new Date().toISOString();
    records = records.filter((r) => r.validUntil >= now || r.status === 'suspended');

    const total = records.length;
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;
    const start = (page - 1) * pageSize;
    return {
      records: records.slice(start, start + pageSize),
      total,
      page,
      pageSize,
    };
  }

  /** 检查技能是否已认证且未过期 */
  isCertified(tenantId: string, skillId: string): boolean {
    const records = Array.from(this.store.values()).filter(
      (r) => r.tenantId === tenantId && r.skillId === skillId && r.status === 'approved',
    );
    if (records.length === 0) return false;
    const now = new Date().toISOString();
    return records.some((r) => r.validUntil >= now);
  }

  /** 检查认证是否已过期 */
  isExpired(certificationId: string): boolean {
    const record = this.store.get(certificationId);
    if (!record) return true;
    return record.validUntil < new Date().toISOString() && record.status !== 'suspended';
  }

  /** 清空存储（测试用） */
  clear(): void {
    this.store.clear();
  }

  // ── 私有辅助 ──

  private assertRecord(certificationId: string): CertificationRecord {
    const record = this.store.get(certificationId);
    if (!record) throw new Error(`Certification not found: ${certificationId}`);
    return record;
  }
}
