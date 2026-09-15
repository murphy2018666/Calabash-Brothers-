/**
 * K3-1 · ConvergenceCheckStep 单元测试
 */

import { ConvergenceCheckStep } from './convergence-check.step';
import type { SkillRecord } from '../skill.service';
import type { ConvergenceChecker, CedarPolicySet } from './convergence-check.step';

describe('ConvergenceCheckStep (K3-1)', () => {
  let checker: ConvergenceChecker;

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

  const buildRecord = (overrides: Partial<SkillRecord> = {}): SkillRecord => ({
    skillId: 'skill-convergence-001',
    manifest: {
      name: 'test-convergence',
      version: '1.0.0',
      type: 'agent' as any,
      riskTier: 'G2' as any,
      description: 'Test skill for convergence',
      ...overrides.manifest,
    },
    state: 'registered' as any,
    signatureVerified: true,
    installedAt: new Date().toISOString(),
    tenantId: 'tenant-1',
    ...overrides,
  });

  beforeEach(() => {
    checker = {
      checkConvergence: jest.fn(),
    };
  });

  it('should pass when convergence check returns ok=true (tighten)', async () => {
    (checker.checkConvergence as jest.Mock).mockReturnValue({
      ok: true,
      direction: 'tighten',
      conflicts: [],
      changes: ['rule allow-read: tightened'],
    });

    const record = buildRecord();
    (record.manifest as any).policyPreset = policyPreset;
    const step = new ConvergenceCheckStep(checker as any);
    const result = await step.execute(record);
    expect(result.passed).toBe(true);
    expect(result.step).toBe('convergenceCheck');
    expect(result.message).toContain('tighten');
  });

  it('should pass when convergence check returns ok=true (neutral)', async () => {
    (checker.checkConvergence as jest.Mock).mockReturnValue({
      ok: true,
      direction: 'neutral',
      conflicts: [],
      changes: ['equivalent'],
    });

    const record = buildRecord();
    (record.manifest as any).policyPreset = policyPreset;
    const step = new ConvergenceCheckStep(checker as any);
    const result = await step.execute(record);
    expect(result.passed).toBe(true);
    expect(result.message).toContain('neutral');
  });

  it('should fail when convergence check returns ok=false (relax)', async () => {
    (checker.checkConvergence as jest.Mock).mockReturnValue({
      ok: false,
      direction: 'relax',
      conflicts: [{ ruleId: 'bad-rule', skillPermission: { actions: ['read'], resources: ['data:*'], conditions: [] }, baselineMatch: null, reason: 'no match' }],
      changes: [],
    });

    const record = buildRecord();
    (record.manifest as any).policyPreset = policyPreset;
    const step = new ConvergenceCheckStep(checker as any);
    const result = await step.execute(record);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('relax');
  });

  it('should pass when no policyPreset in manifest (skipped — neutral)', async () => {
    const step = new ConvergenceCheckStep(checker as any);
    const result = await step.execute(buildRecord());
    expect(result.passed).toBe(true);
    expect(checker.checkConvergence).not.toHaveBeenCalled();
    expect(result.message).toContain('skipped');
  });

  it('should handle convergence check error gracefully (pending manual review)', async () => {
    (checker.checkConvergence as jest.Mock).mockImplementation(() => {
      throw new Error('service unavailable');
    });

    const record = buildRecord();
    (record.manifest as any).policyPreset = policyPreset;
    const step = new ConvergenceCheckStep(checker as any);
    const result = await step.execute(record);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('pending manual review');
  });

  it('should pass when policyPreset has empty rules array', async () => {
    (checker.checkConvergence as jest.Mock).mockReturnValue({
      ok: true,
      direction: 'neutral',
      conflicts: [],
      changes: ['no effective change'],
    });

    const emptyPreset: CedarPolicySet = {
      policySetId: 'empty',
      version: '1.0.0',
      rules: [],
      compiledAt: new Date().toISOString(),
    };
    const record = buildRecord();
    (record.manifest as any).policyPreset = emptyPreset;
    const step = new ConvergenceCheckStep(checker as any);
    const result = await step.execute(record);
    expect(result.passed).toBe(true);
  });
});
