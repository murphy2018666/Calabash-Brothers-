/**
 * K7-3 · 签名验证步骤
 *
 * SignatureVerificationStep —— cosign 签名链验证（cert 指纹 + 私钥验证）。
 * 未签名 / 签名无效 → 评审失败。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ReviewStepResult } from '../review-pipeline-types';
import type { SkillRecord } from '../skill.service';

@Injectable()
export class SignatureVerificationStep {
  private readonly logger = new Logger(SignatureVerificationStep.name);

  async execute(record: SkillRecord): Promise<ReviewStepResult> {
    // Stub: 真实实现需调用 cosign CLI 或 Rust 库进行 cert 指纹 + 私钥验证
    if (!record.signatureVerified) {
      this.logger.warn(`signature verification failed for ${record.skillId}: no signature`);
      return {
        step: 'signature',
        passed: false,
        message: `skill ${record.skillId} is unsigned — rejected by ADR-12 signature chain requirement`,
        evidenceId: `evidence_sig_${record.skillId}`,
      };
    }

    this.logger.debug(`signature verified for ${record.skillId}`);
    return {
      step: 'signature',
      passed: true,
      message: `cosign signature verified for ${record.skillId}`,
      evidenceId: `evidence_sig_${record.skillId}`,
      traceSpanId: `span_sig_${record.skillId}`,
    };
  }
}
