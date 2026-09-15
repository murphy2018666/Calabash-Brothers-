import { Injectable, Logger } from '@nestjs/common';
import { CertificationEngineService, type CertificationRecord } from './certification-engine.service';
import { BillingEngineService } from './billing-engine.service';
import { SplitEngineService, type SplitModel } from './split-engine.service';

/**
 * 认证状态驱动计费钩子（K20-2）。
 *
 * 职责：当技能认证状态变更时，自动调整计费分账模型：
 * - approved → certified split（90/10）
 * - rejected/suspended/expired → standard split（80/20）
 */
@Injectable()
export class CertificationBillingHookService {
  private readonly logger = new Logger(CertificationBillingHookService.name);

  constructor(
    private readonly certificationEngine: CertificationEngineService,
    private readonly billingEngine: BillingEngineService,
    private readonly splitEngine: SplitEngineService,
  ) {}

  /** 处理认证状态变更，触发计费模型切换 */
  onCertificationUpdated(certRecord: CertificationRecord): void {
    if (certRecord.status === 'approved') {
      this.switchToCertifiedRate(certRecord.tenantId, certRecord.skillId);
    } else if (certRecord.status === 'rejected' || certRecord.status === 'suspended') {
      this.restoreStandardRate(certRecord.tenantId, certRecord.skillId);
    }
    // pending/reviewing/expired 不触发计费变更
  }

  /** 切换到认证费率（90/10） */
  switchToCertifiedRate(tenantId: string, skillId: string): void {
    const model: SplitModel = {
      ratio: 'certified',
      skillOwnerPct: 90,
      platformPct: 10,
      certifiedAt: new Date().toISOString(),
    };
    this.splitEngine.setSplitModel(tenantId, skillId, model);
    this.logger.log(`Switched to certified rate for tenant=${tenantId}, skill=${skillId}`);
  }

  /** 恢复标准费率（80/20） */
  restoreStandardRate(tenantId: string, skillId: string): void {
    this.splitEngine.setSplitModel(tenantId, skillId, {
      ratio: 'standard',
      skillOwnerPct: 80,
      platformPct: 20,
    });
    this.logger.log(`Restored standard rate for tenant=${tenantId}, skill=${skillId}`);
  }

  /** 获取技能当前分账模型 */
  getCurrentSplitModel(tenantId: string, skillId: string): SplitModel {
    return this.splitEngine.getSplitModel(tenantId, skillId);
  }

  /** 清空存储（测试用） */
  clear(): void {
    this.splitEngine.clear();
  }
}
