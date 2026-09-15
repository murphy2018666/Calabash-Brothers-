/**
 * K7-3 · SBOM 依赖扫描步骤
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ReviewStepResult } from '../review-pipeline-types';
import type { SkillRecord } from '../skill.service';

@Injectable()
export class DependencyScanStep {
  private readonly logger = new Logger(DependencyScanStep.name);

  async execute(record: SkillRecord): Promise<ReviewStepResult> {
    const deps = record.manifest.dependencies ?? [];
    // Stub: 真实实现需调用 Syft/Grype 解析 SBOM
    if (deps.length === 0) {
      return {
        step: 'sbomScan',
        passed: true,
        message: 'no dependencies found',
        evidenceId: `evidence_sbom_${record.skillId}`,
      };
    }
    this.logger.debug(`dependency scan: ${record.skillId} has ${deps.length} deps`);
    return {
      step: 'sbomScan',
      passed: true,
      message: `${deps.length} dependencies scanned (stub mode)`,
      evidenceId: `evidence_sbom_${record.skillId}`,
    };
  }
}
