/**
 * K7-3 · 策略 simulate 步骤
 *
 * PolicySimulateStep —— 调用 PolicyEngine.simulate() 验证策略预设收敛性。
 * ALLOW → pass；HALLOW/DENY → fail（需人工审核）。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ReviewStepResult } from '../review-pipeline-types';
import type { SkillRecord } from '../skill.service';
import type { AuthorizeRequest, AuthorizeResult } from '@aegisci/shared/types';

/** 策略模拟端口 —— 由控制面注入 Decision 子域的 simulate（FR-M3-08）。 */
export interface PolicySimulator {
  simulate(req: AuthorizeRequest): Promise<AuthorizeResult>;
}

@Injectable()
export class PolicySimulateStep {
  private readonly logger = new Logger(PolicySimulateStep.name);

  constructor(private readonly simulator: PolicySimulator) {}

  async execute(record: SkillRecord): Promise<ReviewStepResult> {
    const req: AuthorizeRequest = {
      principal: {
        id: `skill:${record.skillId}`,
        type: 'service',
        tenantId: record.tenantId,
        roles: [],
      },
      action: 'skill.invoke',
      resource: record.manifest.name,
      context: { riskLevel: record.manifest.riskTier },
    };

    try {
      const result = await this.simulator.simulate(req);
      // ALLOW 通过；HALLOW/DENY → 拒绝（需收窄策略）
      if (result.decision === 'ALLOW') {
        this.logger.debug(`policy simulate ALLOW for ${record.skillId}`);
        return {
          step: 'policySimulate',
          passed: true,
          message: `policy decision: ALLOW`,
          evidenceId: `evidence_policy_${record.skillId}`,
        };
      }

      this.logger.warn(`policy simulate ${result.decision} for ${record.skillId}`);
      return {
        step: 'policySimulate',
        passed: false,
        message: `policy decision: ${result.decision} — skill does not satisfy policy baseline`,
        evidenceId: `evidence_policy_${record.skillId}`,
      };
    } catch (err) {
      this.logger.error(`policy simulate error for ${record.skillId}: ${(err as Error).message}`);
      return {
        step: 'policySimulate',
        passed: false,
        message: `simulate error: ${(err as Error).message}`,
        evidenceId: `evidence_policy_${record.skillId}`,
      };
    }
  }
}
