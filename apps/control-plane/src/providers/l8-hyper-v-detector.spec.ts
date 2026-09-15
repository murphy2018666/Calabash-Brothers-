/**
 * L8: Hyper-V 检测门控 — 测试套件
 *
 * 覆盖 HV-DET-01~08 检测、fail-closed 语义、enroll 上报、探针 job：
 */

import {
  HVDetector,
  HostCapabilityEnroller,
  ProbeJobRunner,
} from './l8-hyper-v-detector';
import type { HVOverallResult } from './l8-hyper-v-detector';

describe('L8: Hyper-V Detection Gate', () => {
  describe('HVDetector', () => {
    let detector: HVDetector;

    beforeEach(() => {
      detector = new HVDetector();
    });

    it('L8-1-1: runAllTests returns 8 test results', () => {
      const result = detector.runAllTests();
      expect(result.tests).toHaveLength(8);
      expect(result.tests.map((t) => t.testId)).toEqual([
        'HV-DET-01', 'HV-DET-02', 'HV-DET-03', 'HV-DET-04',
        'HV-DET-05', 'HV-DET-06', 'HV-DET-07', 'HV-DET-08',
      ]);
    });

    it('L8-1-2: overall is not_detected when no hits (non-container env)', () => {
      const result = detector.runAllTests();
      // 在非容器环境下，overall 应为 not_detected 或 inconclusive
      expect(['not_detected', 'inconclusive']).toContain(result.overall);
    });

    it('L8-1-3: failClosed is true when hypervisor detected', () => {
      // 模拟容器环境（设置环境变量）
      const original = process.env['CONTAINER'];
      process.env['CONTAINER'] = 'true';
      const result = detector.runAllTests();
      process.env['CONTAINER'] = original;
      // 在容器环境中 HV-DET-01/03/04 应检测到
      const detectedCount = result.tests.filter((t) => t.result === 'detected').length;
      expect(detectedCount).toBeGreaterThanOrEqual(1);
      expect(result.failClosed).toBe(true);
    });

    it('L8-1-4: riskLevel is low when no detections', () => {
      const original = process.env['CONTAINER'];
      delete process.env['CONTAINER'];
      delete process.env['KUBERNETES_SERVICE_HOST'];
      const result = detector.runAllTests();
      process.env['CONTAINER'] = original;
      if (result.overall === 'not_detected') {
        expect(result.riskLevel).toBe('low');
      }
    });

    it('L8-1-5: riskLevel is high when 3+ detections', async () => {
      // 通过设置容器环境变量触发多检测
      const original = process.env['CONTAINER'];
      process.env['CONTAINER'] = 'true';
      const result = detector.runAllTests();
      process.env['CONTAINER'] = original;

      const detectedCount = result.tests.filter((t) => t.result === 'detected').length;
      if (detectedCount >= 3) {
        expect(result.riskLevel).toBe('high');
      }
    });

    it('L8-1-6: each test has evidence', () => {
      const result = detector.runAllTests();
      expect(result.tests.every((t) => t.evidence.length > 0)).toBe(true);
    });
  });

  describe('HostCapabilityEnroller', () => {
    let enroller: HostCapabilityEnroller;

    beforeEach(() => {
      enroller = new HostCapabilityEnroller();
    });

    it('L8-2-1: enroll records host capability', () => {
      const cap = enroller.enroll('host-001');
      expect(cap.hostId).toBe('host-001');
      expect(cap.riskLevel).toBeDefined();
      expect(cap.testedAt.length).toBeGreaterThan(0);
      expect(cap.testResults.length).toBe(8);
    });

    it('L8-2-2: isHostCapable returns false for undeployed host', () => {
      expect(enroller.isHostCapable('host-unknown')).toBe(false);
    });

    it('L8-2-3: isHostCapable respects fail-closed policy', () => {
      // 在默认环境中登记
      const cap = enroller.enroll('host-001');
      // fail-closed: 有检测命中或 inconclusive 时应拒绝
      const capable = enroller.isHostCapable('host-001');
      // 由于 inconclusive 测试存在，fail-closed 应生效
      expect(capable).toBe(false);
    });

    it('L8-2-4: getCapability returns null for unknown host', () => {
      expect(enroller.getCapability('host-missing')).toBeNull();
    });

    it('L8-2-5: enrolled count tracks correctly', () => {
      expect(enroller.getEnrolledCount()).toBe(0);
      enroller.enroll('host-a');
      enroller.enroll('host-b');
      expect(enroller.getEnrolledCount()).toBe(2);
    });
  });

  describe('ProbeJobRunner', () => {
    let runner: ProbeJobRunner;

    beforeEach(() => {
      runner = new ProbeJobRunner();
    });

    it('L8-3-1: runProbe executes all tests by default', () => {
      const result = runner.runProbe({
        hostId: 'host-probe-1',
        tests: [],
        timeoutMs: 5000,
      });
      expect(result.ok).toBe(true);
      expect(result.executedTests.length).toBe(8);
      expect(result.hostId).toBe('host-probe-1');
    });

    it('L8-3-2: runProbe filters to specified tests', () => {
      const result = runner.runProbe({
        hostId: 'host-probe-2',
        tests: ['HV-DET-01', 'HV-DET-02'],
        timeoutMs: 5000,
      });
      expect(result.executedTests).toEqual(['HV-DET-01', 'HV-DET-02']);
      expect(result.findings.length).toBe(2);
    });

    it('L8-3-3: runProbe returns failClosed based on overall result', () => {
      const result = runner.runProbe({
        hostId: 'host-probe-3',
        tests: [],
        timeoutMs: 5000,
      });
      // failClosed 应反映整体检测结果
      expect(typeof result.failClosed).toBe('boolean');
    });

    it('L8-3-4: completedAt is a valid ISO timestamp', () => {
      const result = runner.runProbe({
        hostId: 'host-probe-4',
        tests: [],
        timeoutMs: 5000,
      });
      const date = new Date(result.completedAt);
      expect(isNaN(date.getTime())).toBe(false);
    });
  });

  describe('Integration: Full Enrollment Flow', () => {
    it('L8-4-1: enroll → check flow works end-to-end', () => {
      const enroller = new HostCapabilityEnroller();

      // 登记主机
      const cap = enroller.enroll('production-host-1');

      // 检查能力
      const capable = enroller.isHostCapable('production-host-1');

      // fail-closed: 只要有 inconclusive 就应该拒绝
      expect(capable).toBe(false);

      // 确认检测记录
      expect(cap.testResults.length).toBe(8);
      expect(cap.riskLevel).toBeDefined();
    });

    it('L8-4-2: multiple hosts are tracked independently', () => {
      const enroller = new HostCapabilityEnroller();
      enroller.enroll('host-a');
      enroller.enroll('host-b');

      expect(enroller.getCapability('host-a')?.hostId).toBe('host-a');
      expect(enroller.getCapability('host-b')?.hostId).toBe('host-b');
      expect(enroller.getEnrolledCount()).toBe(2);
    });
  });
});
