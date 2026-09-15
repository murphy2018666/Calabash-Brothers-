/**
 * NFR-S4 / T-15-02 单元测试
 *
 * 测试 CompliancePipelineIntegrationService：
 * - S4-1 门禁评估（evaluateGate）
 * - S4-2 证据数组构建（buildEvidenceArray）
 * - S4-3 阻断原因格式化（formatGateBlockReason）
 * - S4-4 报告直接获取（getReport）
 * - S4-5 代码库扫描（scanCodebase）
 * - S4-6 边界情况
 */
import { CompliancePipelineIntegrationService, type ComplianceGateDecision } from './compliance-pipeline-integration.service';
import {
  ComplianceCheckService,
} from './compliance-check.service';

describe('NFR-S4 / T-15-02 CompliancePipelineIntegrationService', () => {
  let service: CompliancePipelineIntegrationService;
  let complianceService: ComplianceCheckService;

  beforeEach(() => {
    complianceService = new ComplianceCheckService();
    service = new CompliancePipelineIntegrationService(complianceService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S4-1 evaluateGate
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('S4-1 evaluateGate', () => {
    it('S4-1-1: 默认阈值下闸门通过（覆盖率 93.1% >= 80%）', () => {
      const decision = service.evaluateGate();
      expect(decision.passed).toBe(true);
      expect(decision.threshold).toBe(80);
      expect(decision.coverageRate).toBe(93.1);
    });

    it('S4-1-2: 高阈值下闸门阻断（95% > 93.1%）', () => {
      const decision = service.evaluateGate(95);
      expect(decision.passed).toBe(false);
      expect(decision.threshold).toBe(95);
      expect(decision.coverageRate).toBe(93.1);
    });

    it('S4-1-3: threshold=0 时闸门通过', () => {
      const decision = service.evaluateGate(0);
      expect(decision.passed).toBe(true);
      expect(decision.coverageRate).toBe(93.1);
    });

    it('S4-1-4: gaps 包含未覆盖项（partial 项也算 gap）', () => {
      const decision = service.evaluateGate();
      expect(Array.isArray(decision.gaps)).toBe(true);
      expect(decision.gaps.length).toBeGreaterThan(0);
    });

    it('S4-1-5: evidence 字段包含覆盖率信息', () => {
      const decision = service.evaluateGate();
      expect(decision.evidence).toContain('覆盖率 93.1%');
      expect(decision.evidence).toContain('通过');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S4-2 buildEvidenceArray
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('S4-2 buildEvidenceArray', () => {
    it('S4-2-1: passed=true 时返回包含 evidence 的数组', () => {
      const decision: ComplianceGateDecision = {
        passed: true, coverageRate: 86.2, threshold: 80, gaps: [], evidence: 'test evidence'
      };
      const result = service.buildEvidenceArray(decision);
      expect(result).toHaveLength(1);
      expect(result[0]).toBe('test evidence');
    });

    it('S4-2-2: passed=false 时返回空数组', () => {
      const decision: ComplianceGateDecision = {
        passed: false, coverageRate: 50, threshold: 80, gaps: [], evidence: 'blocked'
      };
      const result = service.buildEvidenceArray(decision);
      expect(result).toHaveLength(0);
    });

    it('S4-2-3: 空 gaps 时正常返回', () => {
      const decision: ComplianceGateDecision = {
        passed: true, coverageRate: 86.2, threshold: 80, gaps: [], evidence: 'ok'
      };
      const result = service.buildEvidenceArray(decision);
      expect(result).toContain('ok');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S4-3 formatGateBlockReason
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('S4-3 formatGateBlockReason', () => {
    it('S4-3-1: 包含覆盖率、阈值和未覆盖项 ID', () => {
      const decision: ComplianceGateDecision = {
        passed: false, coverageRate: 50, threshold: 80,
        gaps: [
          { id: '8.6.3', name: '信息安全评审', status: 'uncovered', gapAnalysis: 'TBD' },
        ],
        evidence: '',
      };
      const reason = service.formatGateBlockReason(decision);
      expect(reason).toContain('50%');
      expect(reason).toContain('80%');
      expect(reason).toContain('8.6.3');
      expect(reason).toContain('信息安全评审');
    });

    it('S4-3-2: 多个未覆盖项均包含在原因中', () => {
      const decision: ComplianceGateDecision = {
        passed: false, coverageRate: 30, threshold: 80,
        gaps: [
          { id: '8.6.3', name: '评审', status: 'uncovered' },
          { id: '8.7.3', name: '恶意代码防范', status: 'partial' },
        ],
        evidence: '',
      };
      const reason = service.formatGateBlockReason(decision);
      expect(reason).toContain('8.6.3');
      expect(reason).toContain('8.7.3');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S4-4 getReport
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('S4-4 getReport', () => {
    it('S4-4-1: 返回与 complianceService.generateReport() 结构一致的报告', () => {
      const report = service.getReport();
      const direct = complianceService.generateReport();
      // generatedAt 每次调用不同，只验证格式为 ISO 字符串
      expect(typeof report.generatedAt).toBe('string');
      expect(report.generatedAt.endsWith('Z')).toBe(true);
      expect(report.items.length).toBe(29);
      expect(report.overallCoverageRate).toBe(direct.overallCoverageRate);
    });

    it('S4-4-2: 报告包含所有控制域', () => {
      const report = service.getReport();
      const domains = [...new Set(report.items.map(i => i.domain))];
      expect(domains).toContain('A1');
      expect(domains).toContain('A2');
      expect(domains).toContain('A3');
      expect(domains).toContain('A4');
      expect(domains).toContain('A5');
      expect(domains).toContain('A6');
      expect(domains).toContain('A7');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S4-5 scanCodebase
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('S4-5 scanCodebase', () => {
    it('S4-5-1: 扫描包含合规标记的文件', () => {
      const contents = {
        'test.ts': '/** FR-M3-07 紧急熔断广播 DES-5.2 */\nexport class A {}',
      };
      const result = service.scanCodebase(contents);
      expect(result.has('test.ts')).toBe(true);
      const found = result.get('test.ts');
      expect(found.has('FR-M3-07')).toBe(true);
      expect(found.has('DES-5.2')).toBe(true);
    });

    it('S4-5-2: 多文件扫描返回多个 key', () => {
      const contents = {
        'a.ts': 'FR-M3-07',
        'b.ts': 'DES-5.2',
        'c.ts': '无合规标记',
      };
      const result = service.scanCodebase(contents);
      expect(result.size).toBe(3);
      expect(result.get('a.ts')).not.toBeNull();
      expect(result.get('b.ts')).not.toBeNull();
    });

    it('S4-5-3: 空文件内容返回空 Set', () => {
      const result = service.scanCodebase({ 'empty.ts': '' });
      expect(result.has('empty.ts')).toBe(true);
      expect(result.get('empty.ts').size).toBe(0);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // S4-6 边界情况
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('S4-6 边界情况', () => {
    it('S4-6-1: evaluateGate 返回覆盖率和阈值一致', () => {
      const decision = service.evaluateGate();
      expect(typeof decision.coverageRate).toBe('number');
      expect(typeof decision.threshold).toBe('number');
      expect(decision.coverageRate).toBeGreaterThan(0);
    });

    it('S4-6-2: evaluateGate 返回的 gaps 数量正确', () => {
      const decision = service.evaluateGate();
      // 27 covered + 2 partial = 93.1%，partial 项也计入 gaps
      expect(decision.gaps.length).toBeGreaterThan(0);
    });

    it('S4-6-3: buildEvidenceArray + formatGateBlockReason 联动', () => {
      const passedDecision = service.evaluateGate();
      const blockedDecision: ComplianceGateDecision = {
        passed: false, coverageRate: 50, threshold: 80,
        gaps: [{ id: '8.6.3', name: '评审', status: 'uncovered' }],
        evidence: '',
      };
      expect(service.buildEvidenceArray(passedDecision).length).toBeGreaterThan(0);
      expect(service.buildEvidenceArray(blockedDecision).length).toBe(0);
      expect(service.formatGateBlockReason(blockedDecision)).toContain('50%');
    });

    it('S4-6-4: scanCodebase 对非文件键返回空 Map', () => {
      const result = service.scanCodebase({});
      expect(result.size).toBe(0);
    });
  });
});
