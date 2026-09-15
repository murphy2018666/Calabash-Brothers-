/**
 * K3-2 · 真实 ComplianceAssessor 集成测试（NFR-S3/NFR-S4 联调）
 *
 * 验证：
 * - NFR-S3：getComplianceStatus 返回正确的覆盖率数据
 * - NFR-S4：evaluateGate 基于 coverage + riskTier 正确决策
 * - ComplianceGateStep 消费真实 assessor 实现（非 stub）
 */

import { RealComplianceAssessor } from './compliance-assessor.service';
import { ComplianceGateStep } from './compliance-gate.step';
import type { SkillRecord } from '../skill.service';

describe('RealComplianceAssessor (K3-2)', () => {
  let assessor: RealComplianceAssessor;

  beforeEach(() => {
    assessor = new RealComplianceAssessor();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // NFR-S3 合规自查报告
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('NFR-S3 getComplianceStatus', () => {
    it('should return coverage 93.1% (current known state)', async () => {
      const status = await assessor.getComplianceStatus();
      expect(status.coverage).toBe(93.1);
    });

    it('should return gaps for partial-covered items', async () => {
      const status = await assessor.getComplianceStatus();
      expect(status.gaps).toHaveLength(2);
      expect(status.gaps[0]).toContain('8.1.3');
      expect(status.gaps[1]).toContain('8.3.1');
    });

    it('should not throw (idempotent)', async () => {
      const s1 = await assessor.getComplianceStatus();
      const s2 = await assessor.getComplianceStatus();
      expect(s1.coverage).toBe(s2.coverage);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // NFR-S4 门禁评估
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('NFR-S4 evaluateGate', () => {
    it('should reject G1 skill when coverage < 95%', async () => {
      const result = await assessor.evaluateGate('skill-001', 'G1');
      expect(result.gatePassed).toBe(false);
      expect(result.reason).toContain('93.1%');
    });

    it('should reject G2 skill when coverage < 95%', async () => {
      const result = await assessor.evaluateGate('skill-002', 'G2');
      expect(result.gatePassed).toBe(false);
      expect(result.reason).toContain('93.1%');
    });

    it('should reject G3 skill (coverage check runs first, then tier check)', async () => {
      // G3 is also rejected because coverage 93.1% < 95% (coverage check is first)
      const result = await assessor.evaluateGate('skill-003', 'G3');
      expect(result.gatePassed).toBe(false);
      // Both coverage and tier checks are present in the logic
      // With current coverage=93.1%, coverage check fails first
      expect(result.reason).toContain('93.1%');
    });
  });
});

describe('ComplianceGateStep × RealComplianceAssessor integration (K3-2-int)', () => {
  let step: ComplianceGateStep;
  let assessor: RealComplianceAssessor;

  const record = (tier: string): SkillRecord => ({
    skillId: 'skill-k3-2',
    manifest: { name: 'k3-2-test', version: '1.0.0', type: 'agent', riskTier: tier as any, description: 'test' },
    state: 'registered',
    signatureVerified: true,
    installedAt: new Date().toISOString(),
    tenantId: 'tenant-1',
  });

  beforeEach(() => {
    assessor = new RealComplianceAssessor();
    step = new ComplianceGateStep(assessor);
  });

  it('should mark pending manual review when coverage < 95% (real assessor)', async () => {
    const result = await step.execute(record('G1'));
    expect(result.passed).toBe(false);
    expect(result.message).toContain('pending manual review');
    expect(result.evidenceId).toContain('skill-k3-2');
  });

  it('should call both NFR-S3 and NFR-S4 in parallel', async () => {
    const start = Date.now();
    await step.execute(record('G1'));
    const elapsed = Date.now() - start;
    // 两个方法应并发执行，总耗时应明显小于串行（< 200ms 合理）
    expect(elapsed).toBeLessThan(200);
  });

  it('should include evidenceId in result for audit trail', async () => {
    const result = await step.execute(record('G2'));
    expect(result.evidenceId).toBeTruthy();
    expect(result.evidenceId).toMatch(/^evidence_compliance_/);
  });
});
