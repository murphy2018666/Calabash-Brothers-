/**
 * K3-1 · 评审流水线编排器单元测试（7 步骤）
 */

import {
  ReviewPipelineOrchestrator,
  type AuditWormService,
} from './review-pipeline-orchestrator';
import { SignatureVerificationStep } from './review-steps/signature-verification.step';
import { SchemaLintStep } from './review-steps/schema-lint.step';
import { DependencyScanStep } from './review-steps/dependency-scan.step';
import { PromptInjectionScanStep } from './review-steps/prompt-injection-scan.step';
import { PolicySimulateStep } from './review-steps/policy-simulate.step';
import { ConvergenceCheckStep } from './review-steps/convergence-check.step';
import { ComplianceGateStep } from './review-steps/compliance-gate.step';
import type { SkillRecord } from './skill.service';
import type { PolicySimulator } from './review-steps/policy-simulate.step';
import type { ComplianceAssessor } from './review-steps/compliance-gate.step';
import type { ConvergenceChecker, CedarPolicySet } from './review-steps/convergence-check.step';

describe('ReviewPipelineOrchestrator (K3-1)', () => {
  let auditWorm: AuditWormService;
  let policySimulator: PolicySimulator;
  let complianceAssessor: ComplianceAssessor;
  let convergenceChecker: ConvergenceChecker;

  const policyPreset: CedarPolicySet = {
    policySetId: 'test-preset',
    version: '1.0.0',
    rules: [
      {
        ruleId: 'allow-read',
        subject: 'Principal == "agent:reader"',
        action: 'read',
        resource: 'data:public',
        effect: 'Allow',
        condition: 'request.authenticated == true',
        raw: '',
      },
    ],
    compiledAt: new Date().toISOString(),
  };

  const buildRecord = (overrides: Partial<SkillRecord> = {}): SkillRecord => {
    const record: SkillRecord = {
      skillId: 'skill-001',
      manifest: {
        name: 'test-skill',
        version: '1.0.0',
        type: 'agent' as any,
        riskTier: 'G2' as any,
        description: 'Test skill',
        ...overrides.manifest,
      },
      state: 'registered' as any,
      signatureVerified: true,
      installedAt: new Date().toISOString(),
      tenantId: 'tenant-1',
      ...overrides,
    };
    // 直接赋值到 manifest 内部，绕过 TypeScript 类型检查
    if (policyPreset) {
      (record.manifest as any).policyPreset = policyPreset;
    }
    return record;
  };

  beforeEach(() => {
    auditWorm = {
      append: jest.fn().mockResolvedValue('audit-entry-001'),
    };
    policySimulator = {
      simulate: jest.fn().mockResolvedValue({ decision: 'ALLOW' }),
    };
    complianceAssessor = {
      getComplianceStatus: jest.fn().mockResolvedValue({ coverage: 100, gaps: [] }),
      evaluateGate: jest.fn().mockResolvedValue({ gatePassed: true }),
    };
    convergenceChecker = {
      checkConvergence: jest.fn().mockReturnValue({
        ok: true,
        direction: 'neutral',
        conflicts: [],
        changes: ['no effective change'],
      }),
    };
  });

  function buildOrchestrator() {
    return new ReviewPipelineOrchestrator(
      new SignatureVerificationStep(),
      new SchemaLintStep(),
      new DependencyScanStep(),
      new PromptInjectionScanStep(),
      new PolicySimulateStep(policySimulator as any),
      new ConvergenceCheckStep(convergenceChecker as any),
      new ComplianceGateStep(complianceAssessor as any),
      auditWorm,
    );
  }

  it('should return passed=true when all 7 steps pass', async () => {
    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run(buildRecord());

    expect(result.passed).toBe(true);
    expect(result.steps).toHaveLength(7);
    expect(result.steps.every((s) => s.passed)).toBe(true);
    expect(result.auditEntryId).toBe('audit-entry-001');
  });

  it('should return passed=false when convergence check fails', async () => {
    (convergenceChecker.checkConvergence as jest.Mock).mockReturnValue({
      ok: false,
      direction: 'relax',
      conflicts: [{ ruleId: 'bad-rule', skillPermission: { actions: ['read'], resources: ['data:*'], conditions: [] }, baselineMatch: null, reason: 'no match' }],
      changes: [],
    });

    const orchestrator = buildOrchestrator();
    const result = await orchestrator.run(buildRecord());

    expect(result.passed).toBe(false);
    const convergenceStep = result.steps.find((s) => s.step === 'convergenceCheck');
    expect(convergenceStep).toBeDefined();
    expect(convergenceStep!.passed).toBe(false);
  });

  it('should call auditWorm for each of 7 step results', async () => {
    const orchestrator = buildOrchestrator();
    await orchestrator.run(buildRecord());
    expect(auditWorm.append).toHaveBeenCalledTimes(7);
  });

  it('should not fail when auditWorm is not provided (7 steps)', async () => {
    const orchestrator = new ReviewPipelineOrchestrator(
      new SignatureVerificationStep(),
      new SchemaLintStep(),
      new DependencyScanStep(),
      new PromptInjectionScanStep(),
      new PolicySimulateStep(policySimulator as any),
      new ConvergenceCheckStep(convergenceChecker as any),
      new ComplianceGateStep(complianceAssessor as any),
      undefined,
    );
    const result = await orchestrator.run(buildRecord());
    expect(result.passed).toBe(true);
    expect(result.auditEntryId).toBeUndefined();
    expect(result.steps).toHaveLength(7);
  });
});
