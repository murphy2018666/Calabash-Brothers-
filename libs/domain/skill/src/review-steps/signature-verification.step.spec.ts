/**
 * K7-3 · SignatureVerificationStep 单元测试
 */

import { SignatureVerificationStep } from './signature-verification.step';
import type { SkillRecord } from '../skill.service';

describe('SignatureVerificationStep (K7-3-1)', () => {
  let step: SignatureVerificationStep;

  beforeEach(() => {
    step = new SignatureVerificationStep();
  });

  const record = (overrides: Partial<SkillRecord> = {}): SkillRecord => ({
    skillId: 'skill-001',
    manifest: { name: 'test', version: '1.0.0', type: 'agent', riskTier: 'G2', description: 'test' },
    state: 'registered',
    signatureVerified: true,
    installedAt: new Date().toISOString(),
    tenantId: 'tenant-1',
    ...overrides,
  });

  it('should pass when signature is verified', async () => {
    const result = await step.execute(record());
    expect(result.passed).toBe(true);
    expect(result.step).toBe('signature');
    expect(result.evidenceId).toBeTruthy();
  });

  it('should fail when signature is not verified', async () => {
    const result = await step.execute(record({ signatureVerified: false }));
    expect(result.passed).toBe(false);
    expect(result.message).toContain('unsigned');
  });
});
