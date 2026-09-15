/**
 * K7-3 · SchemaLintStep 单元测试
 */

import { SchemaLintStep } from './schema-lint.step';
import type { SkillRecord } from '../skill.service';

describe('SchemaLintStep (K7-3-2)', () => {
  let step: SchemaLintStep;

  beforeEach(() => {
    step = new SchemaLintStep();
  });

  const validRecord = (): SkillRecord => ({
    skillId: 'skill-001',
    manifest: { name: 'test', version: '1.0.0', type: 'agent', riskTier: 'G2', description: 'test' },
    state: 'registered',
    signatureVerified: true,
    installedAt: new Date().toISOString(),
    tenantId: 'tenant-1',
  });

  it('should pass for a well-formed manifest', async () => {
    const result = await step.execute(validRecord());
    expect(result.passed).toBe(true);
  });

  it('should fail when name is missing', async () => {
    const result = await step.execute({ ...validRecord(), manifest: { ...validRecord().manifest, name: '' } });
    expect(result.passed).toBe(false);
    expect(result.message).toContain('name');
  });

  it('should fail when version is missing', async () => {
    const result = await step.execute({ ...validRecord(), manifest: { ...validRecord().manifest, version: '' } });
    expect(result.passed).toBe(false);
    expect(result.message).toContain('version');
  });

  it('should fail when type is invalid', async () => {
    const result = await step.execute({ ...validRecord(), manifest: { ...validRecord().manifest, type: 'unknown' as any } });
    expect(result.passed).toBe(false);
    expect(result.message).toContain('invalid type');
  });

  it('should pass for valid types: agent, policy-pack, tool, connector', async () => {
    for (const type of ['agent', 'policy-pack', 'tool', 'connector'] as const) {
      const result = await step.execute({ ...validRecord(), manifest: { ...validRecord().manifest, type } });
      expect(result.passed).toBe(true);
    }
  });
});
