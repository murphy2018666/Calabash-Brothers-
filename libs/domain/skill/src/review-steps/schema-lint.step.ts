/**
 * K7-3 · Schema lint 步骤
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ReviewStepResult } from '../review-pipeline-types';
import type { SkillRecord } from '../skill.service';

@Injectable()
export class SchemaLintStep {
  private readonly logger = new Logger(SchemaLintStep.name);

  private readonly REQUIRED_FIELDS = ['name', 'version', 'type', 'riskTier'] as const;
  private readonly VALID_TYPES = ['agent', 'policy-pack', 'tool', 'connector'] as const;

  async execute(record: SkillRecord): Promise<ReviewStepResult> {
    const errors: string[] = [];
    const { manifest } = record;

    for (const field of this.REQUIRED_FIELDS) {
      if (!manifest[field]) {
        errors.push(`missing required field: ${field}`);
      }
    }

    if (manifest.type && !this.VALID_TYPES.includes(manifest.type as any)) {
      errors.push(`invalid type '${manifest.type}' — expected one of: ${this.VALID_TYPES.join(', ')}`);
    }

    const passed = errors.length === 0;
    if (!passed) {
      this.logger.warn(`schema lint failed for ${record.skillId}: ${errors.join('; ')}`);
    }

    return {
      step: 'schemaLint',
      passed,
      message: passed ? 'schema lint passed' : errors.join('; '),
      evidenceId: `evidence_schema_${record.skillId}`,
    };
  }
}
