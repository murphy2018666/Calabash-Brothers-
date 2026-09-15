/**
 * K4-1: 合规映射包（SOC2 / 等保三级）
 *
 * 将控制面 SPI 实现与合规要求建立映射关系，支持：
 * - SOC2 Type II 控制项映射
 * - 等保三级 8.3.x 安全要求映射
 * - 映射完整性校验（所有要求有对应实现）
 */

import type { CedarPolicySet, CedarRule } from '@aegisci/domain/policy/parsers/cedar-policy-parser.service';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ComplianceRequirement {
  /** 合规框架 ID（如 'soc2', '等保三级'） */
  framework: string;
  /** 控制项编号 */
  controlId: string;
  /** 控制项描述 */
  description: string;
  /** 风险等级（high/medium/low） */
  riskLevel: 'high' | 'medium' | 'low';
}

export interface ComplianceMapping {
  /** 映射 ID */
  id: string;
  /** 关联的合规要求 */
  requirement: ComplianceRequirement;
  /** 对应的 SPI 实现类名 */
  spiImplementation: string;
  /** 对应的 Cedar 规则 ID（如有） */
  policyRuleId?: string;
  /** 测试用例 ID */
  testCaseId?: string;
  /** 映射状态（mapped/unmapped/partial） */
  status: 'mapped' | 'unmapped' | 'partial';
}

export interface ComplianceMapResult {
  /** 框架名称 */
  framework: string;
  /** 总要求数 */
  total: number;
  /** 已映射数 */
  mapped: number;
  /** 未映射数 */
  unmapped: number;
  /** 映射列表 */
  mappings: ComplianceMapping[];
  /** 完整性比例 */
  completeness: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 合规映射加载器
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class ComplianceMappingLoader {
  /** SOC2 Type II 控制项库 */
  private readonly soc2Requirements: ComplianceRequirement[] = [
    { framework: 'soc2', controlId: 'CC6.1', description: '逻辑与物理访问控制', riskLevel: 'high' },
    { framework: 'soc2', controlId: 'CC6.2', description: '用户身份验证', riskLevel: 'high' },
    { framework: 'soc2', controlId: 'CC6.3', description: '权限分离与最小权限', riskLevel: 'high' },
    { framework: 'soc2', controlId: 'CC7.1', description: '系统组件变更管理', riskLevel: 'medium' },
    { framework: 'soc2', controlId: 'CC7.2', description: '变更审批与回滚', riskLevel: 'medium' },
    { framework: 'soc2', controlId: 'CC8.1', description: '审计日志完整性', riskLevel: 'high' },
    { framework: 'soc2', controlId: 'CC8.2', description: '审计日志保护（WORM）', riskLevel: 'high' },
    { framework: 'soc2', controlId: 'CC9.1', description: '风险评估机制', riskLevel: 'medium' },
    { framework: 'soc2', controlId: 'CC10.1', description: '异常检测与响应', riskLevel: 'medium' },
    { framework: 'soc2', controlId: 'A1.1', description: '服务可用性', riskLevel: 'medium' },
  ];

  /** 等保三级安全要求库 */
  private readonly djbRequirements: ComplianceRequirement[] = [
    { framework: '等保三级', controlId: '8.3.1', description: '身份鉴别', riskLevel: 'high' },
    { framework: '等保三级', controlId: '8.3.2', description: '访问控制', riskLevel: 'high' },
    { framework: '等保三级', controlId: '8.3.3', description: '安全审计', riskLevel: 'high' },
    { framework: '等保三级', controlId: '8.3.4', description: '入侵防范', riskLevel: 'high' },
    { framework: '等保三级', controlId: '8.3.5', description: '恶意代码防范', riskLevel: 'medium' },
    { framework: '等保三级', controlId: '8.3.6', description: '残余信息保护', riskLevel: 'medium' },
    { framework: '等保三级', controlId: '8.3.7', description: '机密性保护', riskLevel: 'high' },
    { framework: '等保三级', controlId: '8.3.8', description: '完整性保护', riskLevel: 'high' },
    { framework: '等保三级', controlId: '8.4.1', description: '通信网络窃密防护', riskLevel: 'high' },
    { framework: '等保三级', controlId: '8.4.2', description: '通信网络伪装防护', riskLevel: 'high' },
  ];

  /** 已建立的映射 */
  private readonly mappings: ComplianceMapping[] = [];

  /**
   * 加载 SOC2 映射
   */
  loadSoc2Mappings(): ComplianceMapResult {
    const soc2Mappings: ComplianceMapping[] = [
      {
        id: 'soc2-cc6-1',
        requirement: this.soc2Requirements[0],
        spiImplementation: 'EmbeddedPolicyEngine',
        policyRuleId: 'policy-engine-access-control',
        testCaseId: 'l6-spi-invariants',
        status: 'mapped',
      },
      {
        id: 'soc2-cc6-2',
        requirement: this.soc2Requirements[1],
        spiImplementation: 'EnvFileSecretProvider',
        testCaseId: 'l5-spi-switch',
        status: 'mapped',
      },
      {
        id: 'soc2-cc6-3',
        requirement: this.soc2Requirements[2],
        spiImplementation: 'EmbeddedPolicyEngine',
        policyRuleId: 'policy-engine-least-privilege',
        testCaseId: 'l6-shadow-mode',
        status: 'mapped',
      },
      {
        id: 'soc2-cc7-1',
        requirement: this.soc2Requirements[3],
        spiImplementation: 'PolicyPresetApplierService',
        testCaseId: 'convergence-check',
        status: 'mapped',
      },
      {
        id: 'soc2-cc7-2',
        requirement: this.soc2Requirements[4],
        spiImplementation: 'ReviewPipelineOrchestrator',
        testCaseId: 'skill-review-pipeline',
        status: 'mapped',
      },
      {
        id: 'soc2-cc8-1',
        requirement: this.soc2Requirements[5],
        spiImplementation: 'InMemoryAuditWormSink',
        testCaseId: 'e3-5-audit-chain',
        status: 'mapped',
      },
      {
        id: 'soc2-cc8-2',
        requirement: this.soc2Requirements[6],
        spiImplementation: 'InMemoryAuditWormSink',
        testCaseId: 'e3-5-audit-chain',
        status: 'mapped',
      },
      {
        id: 'soc2-cc9-1',
        requirement: this.soc2Requirements[7],
        spiImplementation: 'InjectionDetector',
        testCaseId: 'i2-injection-defense',
        status: 'mapped',
      },
      {
        id: 'soc2-cc10-1',
        requirement: this.soc2Requirements[8],
        spiImplementation: 'InjectionDetector',
        testCaseId: 'i2-injection-defense-v3',
        status: 'mapped',
      },
      {
        id: 'soc2-a1-1',
        requirement: this.soc2Requirements[9],
        spiImplementation: 'OciSkillRegistry',
        testCaseId: 'oci-skill-registry',
        status: 'mapped',
      },
    ];
    this.mappings.push(...soc2Mappings);
    return this.buildResult('soc2', this.soc2Requirements, soc2Mappings);
  }

  /**
   * 加载等保三级映射
   */
  loadDjbMappings(): ComplianceMapResult {
    const djbMappings: ComplianceMapping[] = [
      {
        id: 'djb-831',
        requirement: this.djbRequirements[0],
        spiImplementation: 'EnvFileSecretProvider',
        testCaseId: 'vault-secret-provider',
        status: 'mapped',
      },
      {
        id: 'djb-832',
        requirement: this.djbRequirements[1],
        spiImplementation: 'EmbeddedPolicyEngine',
        policyRuleId: 'djb-access-control',
        testCaseId: 'l6-spi-invariants',
        status: 'mapped',
      },
      {
        id: 'djb-833',
        requirement: this.djbRequirements[2],
        spiImplementation: 'InMemoryAuditWormSink',
        testCaseId: 'e3-5-audit-chain',
        status: 'mapped',
      },
      {
        id: 'djb-834',
        requirement: this.djbRequirements[3],
        spiImplementation: 'InjectionDetector',
        testCaseId: 'i2-injection-defense',
        status: 'mapped',
      },
      {
        id: 'djb-835',
        requirement: this.djbRequirements[4],
        spiImplementation: 'OpaPolicyEngine',
        testCaseId: 'opa-policy-engine',
        status: 'mapped',
      },
      {
        id: 'djb-836',
        requirement: this.djbRequirements[5],
        spiImplementation: 'VaultSecretProvider',
        testCaseId: 'vault-secret-provider',
        status: 'partial',
      },
      {
        id: 'djb-837',
        requirement: this.djbRequirements[6],
        spiImplementation: 'VaultSecretProvider',
        testCaseId: 'vault-secret-provider',
        status: 'mapped',
      },
      {
        id: 'djb-838',
        requirement: this.djbRequirements[7],
        spiImplementation: 'CosignSigner',
        testCaseId: 'cosign-signer',
        status: 'mapped',
      },
      {
        id: 'djb-841',
        requirement: this.djbRequirements[8],
        spiImplementation: 'OtelOtlpTraceExporter',
        testCaseId: 'l4-trace-exporter',
        status: 'mapped',
      },
      {
        id: 'djb-842',
        requirement: this.djbRequirements[9],
        spiImplementation: 'EmbeddedPolicyEngine',
        policyRuleId: 'djb-authentication',
        testCaseId: 'tool-call-authorize-guard',
        status: 'mapped',
      },
    ];
    this.mappings.push(...djbMappings);
    return this.buildResult('等保三级', this.djbRequirements, djbMappings);
  }

  /**
   * 获取所有映射
   */
  getAllMappings(): ComplianceMapping[] {
    return [...this.mappings];
  }

  /**
   * 按框架获取映射
   */
  getMappingsByFramework(framework: string): ComplianceMapping[] {
    return this.mappings.filter((m) => m.requirement.framework === framework);
  }

  /**
   * 校验映射完整性
   */
  validateCompleteness(framework: string): { ok: boolean; missing: string[]; completed: string[] } {
    const allRequirements = [...this.soc2Requirements, ...this.djbRequirements];
    const frameworkReqs = allRequirements.filter((r) => r.framework === framework);
    const mappedIds = new Set(this.mappings.filter((m) => m.requirement.framework === framework).map((m) => m.requirement.controlId));

    const missing: string[] = [];
    const completed: string[] = [];

    for (const req of frameworkReqs) {
      if (mappedIds.has(req.controlId)) {
        completed.push(req.controlId);
      } else {
        missing.push(req.controlId);
      }
    }

    return {
      ok: missing.length === 0,
      missing,
      completed,
    };
  }

  // ── 内部方法 ──

  private buildResult(
    framework: string,
    requirements: ComplianceRequirement[],
    mappings: ComplianceMapping[],
  ): ComplianceMapResult {
    const mappedCount = mappings.filter((m) => m.status === 'mapped').length;
    return {
      framework,
      total: requirements.length,
      mapped: mappedCount,
      unmapped: requirements.length - mappedCount,
      mappings,
      completeness: mappedCount / requirements.length,
    };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试套件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('K4-1: 合规映射包（SOC2 / 等保三级）', () => {
  let loader: ComplianceMappingLoader;

  beforeEach(() => {
    loader = new ComplianceMappingLoader();
  });

  describe('SOC2 Type II 映射', () => {
    it('K4-1-1: 加载 SOC2 映射并返回完整结果', () => {
      const result = loader.loadSoc2Mappings();
      expect(result.framework).toBe('soc2');
      expect(result.total).toBe(10);
      expect(result.mapped).toBe(10);
      expect(result.unmapped).toBe(0);
      expect(result.completeness).toBe(1.0);
      expect(result.mappings.length).toBe(10);
    });

    it('K4-1-2: 所有 SOC2 映射状态为 mapped', () => {
      const result = loader.loadSoc2Mappings();
      expect(result.mappings.every((m) => m.status === 'mapped')).toBe(true);
    });

    it('K4-1-3: SOC2 映射关联正确 SPI 实现', () => {
      const result = loader.loadSoc2Mappings();
      const policyMappings = result.mappings.filter((m) => m.spiImplementation === 'EmbeddedPolicyEngine');
      expect(policyMappings.length).toBeGreaterThan(0);
      policyMappings.forEach((m) => {
        expect(m.testCaseId).toBeTruthy();
      });
    });
  });

  describe('等保三级映射', () => {
    it('K4-1-4: 加载等保三级映射并返回完整结果', () => {
      const result = loader.loadDjbMappings();
      expect(result.framework).toBe('等保三级');
      expect(result.total).toBe(10);
      expect(result.mapped).toBe(9); // 8.3.6 为 partial
      expect(result.unmapped).toBe(1);
      expect(result.completeness).toBeGreaterThanOrEqual(0.9);
    });

    it('K4-1-5: 等保三级映射覆盖所有高风险要求', () => {
      const result = loader.loadDjbMappings();
      const highRiskMappings = result.mappings.filter((m) => m.requirement.riskLevel === 'high');
      expect(highRiskMappings.every((m) => m.status === 'mapped' || m.status === 'partial')).toBe(true);
    });
  });

  describe('映射完整性校验', () => {
    it('K4-1-6: SOC2 完整性校验通过', () => {
      loader.loadSoc2Mappings();
      const validation = loader.validateCompleteness('soc2');
      expect(validation.ok).toBe(true);
      expect(validation.missing).toHaveLength(0);
      expect(validation.completed).toHaveLength(10);
    });

    it('K4-1-7: 等保三级完整性校验通过（含 partial）', () => {
      loader.loadDjbMappings();
      const validation = loader.validateCompleteness('等保三级');
      expect(validation.ok).toBe(true);
      expect(validation.missing).toHaveLength(0);
      expect(validation.completed).toHaveLength(10);
    });

    it('K4-1-8: 空映射校验返回全部缺失', () => {
      const validation = loader.validateCompleteness('soc2');
      expect(validation.ok).toBe(false);
      expect(validation.missing.length).toBe(10);
      expect(validation.completed).toHaveLength(0);
    });
  });

  describe('查询接口', () => {
    it('K4-1-9: 按框架查询映射', () => {
      loader.loadSoc2Mappings();
      const soc2Mappings = loader.getMappingsByFramework('soc2');
      expect(soc2Mappings.length).toBe(10);
      expect(soc2Mappings.every((m) => m.requirement.framework === 'soc2')).toBe(true);
    });

    it('K4-1-10: 查询不存在的框架返回空数组', () => {
      const empty = loader.getMappingsByFramework('非存在框架');
      expect(empty).toEqual([]);
    });

    it('K4-1-11: 所有映射关联测试用例 ID', () => {
      loader.loadSoc2Mappings();
      loader.loadDjbMappings();
      const all = loader.getAllMappings();
      expect(all.every((m) => m.testCaseId)).toBe(true);
    });
  });

  describe('Cedar 策略映射', () => {
    it('K4-1-12: 映射包含 Cedar 规则引用', () => {
      loader.loadSoc2Mappings();
      const withRules = loader.getAllMappings().filter((m) => m.policyRuleId);
      expect(withRules.length).toBeGreaterThan(0);
      withRules.forEach((m) => {
        expect(typeof m.policyRuleId).toBe('string');
        expect(m.policyRuleId!.length).toBeGreaterThan(0);
      });
    });
  });
});
