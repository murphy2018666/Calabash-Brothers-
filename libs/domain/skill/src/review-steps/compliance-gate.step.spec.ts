/**
 * K7-3 · ComplianceGateStep 单元测试
 */

import { ComplianceGateStep } from './compliance-gate.step';
import type { SkillRecord } from '../skill.service';
import type { ComplianceAssessor } from './compliance-gate.step';

describe('ComplianceGateStep (K7-3-4)', () => {
  let step: ComplianceGateStep;
  let assessor: ComplianceAssessor;

  const record = (): SkillRecord => ({
    skillId: 'skill-001',
    manifest: { name: 'test', version: '1.0.0', type: 'agent', riskTier: 'G2', description: 'test' },
    state: 'registered',
    signatureVerified: true,
    installedAt: new Date().toISOString(),
    tenantId: 'tenant-1',
  });

  beforeEach(() => {
    assessor = {
      getComplianceStatus: jest.fn(),
      evaluateGate: jest.fn(),
    };
    step = new ComplianceGateStep(assessor as any);
  });

  it('should pass when coverage >= 95% and gate passes', async () => {
    (assessor.getComplianceStatus as jest.Mock).mockResolvedValue({ coverage: 100, gaps: [] });
    (assessor.evaluateGate as jest.Mock).mockResolvedValue({ gatePassed: true });
    const result = await step.execute(record());
    expect(result.passed).toBe(true);
  });

  it('should fail when coverage < 95%', async () => {
    (assessor.getComplianceStatus as jest.Mock).mockResolvedValue({ coverage: 80, gaps: ['G1'] });
    (assessor.evaluateGate as jest.Mock).mockResolvedValue({ gatePassed: true });
    const result = await step.execute(record());
    expect(result.passed).toBe(false);
    expect(result.message).toContain('pending manual review');
  });

  it('should fail when gate is rejected', async () => {
    (assessor.getComplianceStatus as jest.Mock).mockResolvedValue({ coverage: 100, gaps: [] });
    (assessor.evaluateGate as jest.Mock).mockResolvedValue({ gatePassed: false, reason: 'tier mismatch' });
    const result = await step.execute(record());
    expect(result.passed).toBe(false);
  });

  it('should return pending manual review when assessor throws', async () => {
    (assessor.getComplianceStatus as jest.Mock).mockRejectedValue(new Error('timeout'));
    const result = await step.execute(record());
    expect(result.passed).toBe(false);
    expect(result.message).toContain('pending manual review');
  });
});
