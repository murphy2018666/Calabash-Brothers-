/**
 * K7-3 · 合规门禁裁决步骤
 *
 * ComplianceGateStep —— 调用 NFR-S3 合规自查报告服务 + NFR-S4 门禁评估。
 * 仅读取操作；失败时降级为"待人工确认"，不阻塞流水线。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ReviewStepResult } from '../review-pipeline-types';
import type { SkillRecord } from '../skill.service';

export interface ComplianceAssessor {
  /** 获取当前合规状态（NFR-S3） */
  getComplianceStatus(): Promise<{ coverage: number; gaps: string[] }>;
  /** 评估技能是否符合当前门禁（NFR-S4） */
  evaluateGate(skillId: string, riskTier: string): Promise<{ gatePassed: boolean; reason?: string }>;
}

@Injectable()
export class ComplianceGateStep {
  private readonly logger = new Logger(ComplianceGateStep.name);

  /** 最低合规覆盖率阈值（等保三级要求 ≥ 95%） */
  private readonly MIN_COVERAGE = 95;

  constructor(private readonly assessor: ComplianceAssessor) {}

  async execute(record: SkillRecord): Promise<ReviewStepResult> {
    try {
      const [compliance, gate] = await Promise.all([
        this.assessor.getComplianceStatus(),
        this.assessor.evaluateGate(record.skillId, record.manifest.riskTier),
      ]);

      // 覆盖率不足 → 降级为待人工确认（不阻塞）
      if (compliance.coverage < this.MIN_COVERAGE) {
        this.logger.warn(
          `compliance coverage ${compliance.coverage}% < ${this.MIN_COVERAGE}% — marking as pending manual review`,
        );
        return {
          step: 'complianceGate',
          passed: false,
          message: `coverage ${compliance.coverage}% < ${this.MIN_COVERAGE}% threshold — pending manual review`,
          evidenceId: `evidence_compliance_${record.skillId}`,
        };
      }

      if (!gate.gatePassed) {
        return {
          step: 'complianceGate',
          passed: false,
          message: `gate rejected: ${gate.reason ?? 'unknown'}`,
          evidenceId: `evidence_compliance_${record.skillId}`,
        };
      }

      this.logger.debug(`compliance gate passed for ${record.skillId}`);
      return {
        step: 'complianceGate',
        passed: true,
        message: `coverage ${compliance.coverage}% ≥ ${this.MIN_COVERAGE}%; gate passed`,
        evidenceId: `evidence_compliance_${record.skillId}`,
      };
    } catch (err) {
      // 降级：门禁服务不可用 → 标记待人工确认
      this.logger.error(`compliance gate error: ${(err as Error).message} — deferring to manual review`);
      return {
        step: 'complianceGate',
        passed: false,
        message: `compliance gate unavailable: ${(err as Error).message} — pending manual review`,
        evidenceId: `evidence_compliance_${record.skillId}`,
      };
    }
  }
}
