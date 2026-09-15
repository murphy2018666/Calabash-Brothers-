/**
 * K3-1 · 评审流水线编排器（7 步骤）
 *
 * 步骤顺序：
 *   1. signature — 签名验证
 *   2. schemaLint — Schema lint
 *   3. sbomScan — 依赖 SBOM 扫描
 *   4. promptInjection — Prompt 注入静态扫描
 *   5. policySimulate — 策略 simulate（Cedar 决策）
 *   6. convergenceCheck — 收敛偏序判定（DES-11.5）
 *   7. complianceGate — 合规门禁裁决
 */

import { Injectable, Logger } from '@nestjs/common';
import type { SkillRecord } from './skill.service';
import type { ReviewContext, ReviewPipelineResult, ReviewStepName } from './review-pipeline-types';
import { SignatureVerificationStep } from './review-steps/signature-verification.step';
import { SchemaLintStep } from './review-steps/schema-lint.step';
import { DependencyScanStep } from './review-steps/dependency-scan.step';
import { PromptInjectionScanStep } from './review-steps/prompt-injection-scan.step';
import { PolicySimulateStep } from './review-steps/policy-simulate.step';
import { ConvergenceCheckStep } from './review-steps/convergence-check.step';
import { ComplianceGateStep } from './review-steps/compliance-gate.step';

export interface AuditWormService {
  append(entry: AuditWormEntry): Promise<string>;
}

export interface AuditWormEntry {
  readonly skillId: string;
  readonly eventType: 'ReviewPipelineExecuted';
  readonly step: ReviewStepName;
  readonly passed: boolean;
  readonly message: string;
  readonly evidenceId: string;
  readonly traceSpanId?: string;
  readonly reviewedAt: string;
}

@Injectable()
export class ReviewPipelineOrchestrator {
  private readonly logger = new Logger(ReviewPipelineOrchestrator.name);

  constructor(
    private readonly sigStep: SignatureVerificationStep,
    private readonly lintStep: SchemaLintStep,
    private readonly sbomStep: DependencyScanStep,
    private readonly injectionStep: PromptInjectionScanStep,
    private readonly policyStep: PolicySimulateStep,
    private readonly convergenceStep: ConvergenceCheckStep,
    private readonly complianceStep: ComplianceGateStep,
    private readonly auditWorm?: AuditWormService,
  ) {}

  async run(record: SkillRecord): Promise<ReviewPipelineResult> {
    const context: ReviewContext = { record, findings: [] };
    const steps: ReviewStepName[] = [
      'signature',
      'schemaLint',
      'sbomScan',
      'promptInjection',
      'policySimulate',
      'convergenceCheck',
      'complianceGate',
    ];

    for (const step of steps) {
      const result = await this.executeStep(step, record);
      context.findings.push(result);
      this.logger.debug(`step ${step}: ${result.passed ? 'PASS' : 'FAIL'} — ${result.message}`);
    }

    const passed = context.findings.every((f) => f.passed);
    const reviewedAt = new Date().toISOString();

    let auditEntryId: string | undefined;
    if (this.auditWorm) {
      auditEntryId = await this.writeToWorm(record, context.findings, reviewedAt);
    }

    return {
      skillId: record.skillId,
      passed,
      steps: context.findings,
      reviewedAt,
      auditEntryId,
    };
  }

  private async executeStep(
    step: ReviewStepName,
    record: SkillRecord,
  ): Promise<import('./review-pipeline-types').ReviewStepResult> {
    switch (step) {
      case 'signature':
        return this.sigStep.execute(record);
      case 'schemaLint':
        return this.lintStep.execute(record);
      case 'sbomScan':
        return this.sbomStep.execute(record);
      case 'promptInjection':
        return this.injectionStep.execute(record);
      case 'policySimulate':
        return this.policyStep.execute(record);
      case 'convergenceCheck':
        return this.convergenceStep.execute(record);
      case 'complianceGate':
        return this.complianceStep.execute(record);
      default:
        throw new Error(`unknown review step: ${step}`);
    }
  }

  private async writeToWorm(
    record: SkillRecord,
    findings: import('./review-pipeline-types').ReviewStepResult[],
    reviewedAt: string,
  ): Promise<string> {
    const entries: AuditWormEntry[] = findings.map((f) => ({
      skillId: record.skillId,
      eventType: 'ReviewPipelineExecuted',
      step: f.step,
      passed: f.passed,
      message: f.message,
      evidenceId: f.evidenceId ?? `evidence_${record.skillId}_${f.step}`,
      traceSpanId: f.traceSpanId,
      reviewedAt,
    }));

    const ids = await Promise.all(entries.map((e) => this.auditWorm!.append(e)));
    return ids[0];
  }
}
