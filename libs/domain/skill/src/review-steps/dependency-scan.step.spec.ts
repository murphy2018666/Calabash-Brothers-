/**
 * K7-3 · DependencyScanStep 单元测试
 */

import { DependencyScanStep } from './dependency-scan.step';
import type { SkillRecord } from '../skill.service';

describe('DependencyScanStep (K7-3-3-SBOM)', () => {
  let step: DependencyScanStep;

  beforeEach(() => {
    step = new DependencyScanStep();
  });

  const record = (overrides: Partial<SkillRecord> = {}): SkillRecord => ({
    skillId: 'skill-001',
    manifest: {
      name: 'test',
      version: '1.0.0',
      type: 'agent',
      riskTier: 'G2',
      description: 'test',
      ...overrides.manifest,
    },
    state: 'registered',
    signatureVerified: true,
    installedAt: new Date().toISOString(),
    tenantId: 'tenant-1',
    ...overrides,
  });

  it('should pass when no dependencies', async () => {
    const result = await step.execute(record());
    expect(result.passed).toBe(true);
  });

  it('should pass when deps exist', async () => {
    const result = await step.execute(
      record({ manifest: { name: 'test', version: '1.0.0', type: 'agent', riskTier: 'G2', description: 'test', dependencies: ['pkg-a'] } }),
    );
    expect(result.passed).toBe(true);
  });
});
