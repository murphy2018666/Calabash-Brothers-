/**
 * K7-3 · PolicySimulateStep 单元测试
 */

import { PolicySimulateStep } from './policy-simulate.step';
import type { SkillRecord } from '../skill.service';
import type { PolicySimulator } from './policy-simulate.step';

describe('PolicySimulateStep (K7-3-4)', () => {
  let step: PolicySimulateStep;
  let simulator: PolicySimulator;

  const record = (overrides: Partial<SkillRecord> = {}): SkillRecord => ({
    skillId: 'skill-001',
    manifest: { name: 'test', version: '1.0.0', type: 'agent', riskTier: 'G2', description: 'test', ...overrides.manifest },
    state: 'registered',
    signatureVerified: true,
    installedAt: new Date().toISOString(),
    tenantId: 'tenant-1',
    ...overrides,
  });

  beforeEach(() => {
    simulator = { simulate: jest.fn() };
    step = new PolicySimulateStep(simulator as any);
  });

  it('should pass when policy returns ALLOW', async () => {
    (simulator.simulate as jest.Mock).mockResolvedValue({ decision: 'ALLOW' });
    const result = await step.execute(record());
    expect(result.passed).toBe(true);
    expect(result.message).toContain('ALLOW');
  });

  it('should fail when policy returns DENY', async () => {
    (simulator.simulate as jest.Mock).mockResolvedValue({ decision: 'DENY' });
    const result = await step.execute(record());
    expect(result.passed).toBe(false);
  });

  it('should fail when policy simulate throws', async () => {
    (simulator.simulate as jest.Mock).mockRejectedValue(new Error('service unavailable'));
    const result = await step.execute(record());
    expect(result.passed).toBe(false);
  });
});
