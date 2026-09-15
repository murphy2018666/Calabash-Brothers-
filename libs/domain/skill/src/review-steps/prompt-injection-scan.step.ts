/**
 * K7-3 · Prompt 注入静态扫描步骤
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ReviewStepResult } from '../review-pipeline-types';
import type { SkillRecord } from '../skill.service';

@Injectable()
export class PromptInjectionScanStep {
  private readonly logger = new Logger(PromptInjectionScanStep.name);

  private readonly INJECTION_PATTERNS = [
    /ignore\s+previous/i,
    /do\s+not\s+follow\s+instructions/i,
    /you\s+are\s+now\s+an?\s+/i,
    /\{\{.*\}\}/,
    /system:\s*override/i,
  ] as RegExp[];

  async execute(record: SkillRecord): Promise<ReviewStepResult> {
    const findings: string[] = [];
    const payload = JSON.stringify(record.manifest).toLowerCase();

    for (const pattern of this.INJECTION_PATTERNS) {
      if (pattern.test(payload)) {
        findings.push(`matched injection pattern: ${pattern.source}`);
      }
    }

    const passed = findings.length === 0;
    if (!passed) {
      this.logger.warn(`prompt injection scan found ${findings.length} finding(s) for ${record.skillId}`);
    }

    return {
      step: 'promptInjection',
      passed,
      message: passed
        ? 'no prompt injection patterns detected'
        : findings.join('; '),
      evidenceId: `evidence_injection_${record.skillId}`,
    };
  }
}
