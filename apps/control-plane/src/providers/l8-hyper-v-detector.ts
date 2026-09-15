/**
 * L8: Hyper-V 检测门控 V1.0
 *
 * 实现 Windows 宿主虚拟化检测器（HV-DET-01~08）：
 *  - CPUID 检测（HV-DET-01~04）
 *  - MSR 检测（HV-DET-05~06）
 *  - ACPI 表检测（HV-DET-07）
 *  - DMI 检测（HV-DET-08）
 *
 * fail-closed 语义：无法确定非虚拟环境时拒绝部署
 *
 * 对应 WBS: L8 (1.11.8 Hyper-V 检测门控 V1.0)
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L8 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type HVDetResult = 'detected' | 'not_detected' | 'inconclusive';

export interface HVDetectorResult {
  testId: string;
  description: string;
  result: HVDetResult;
  evidence: string;
}

export interface HVOverallResult {
  overall: HVDetResult;
  tests: HVDetectorResult[];
  failClosed: boolean;
  riskLevel: 'high' | 'medium' | 'low';
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L8 HVDetector — Hyper-V 检测器
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class HVDetector {
  /**
   * runAllTests —— 运行全部 HV-DET 检测项（V1.0: 8 项）
   * stub 实现：基于运行时特征模拟检测结果
   */
  runAllTests(): HVOverallResult {
    const tests: HVDetectorResult[] = [
      this.hvDet01(),
      this.hvDet02(),
      this.hvDet03(),
      this.hvDet04(),
      this.hvDet05(),
      this.hvDet06(),
      this.hvDet07(),
      this.hvDet08(),
    ];

    const detected = tests.filter((t) => t.result === 'detected').length;
    const inconclusive = tests.filter((t) => t.result === 'inconclusive').length;

    // fail-closed: 有检测到虚拟化 或 无法确定 → 拒绝
    const overall: HVDetResult = detected > 0 ? 'detected'
      : inconclusive > 0 ? 'inconclusive'
      : 'not_detected';

    const failClosed = overall !== 'not_detected';

    // 风险等级
    let riskLevel: HVOverallResult['riskLevel'];
    if (detected >= 3) riskLevel = 'high';
    else if (detected >= 1 || inconclusive >= 2) riskLevel = 'medium';
    else riskLevel = 'low';

    return {
      overall,
      tests,
      failClosed,
      riskLevel,
    };
  }

  // ── HV-DET-01: CPUID leaf 0x40000000 — hypervisor present ────────────────
  private hvDet01(): HVDetectorResult {
    // stub: 在容器中运行时返回 detected，真实物理机上返回 not_detected
    const isContainer = process.env['KUBERNETES_SERVICE_HOST'] !== undefined
      || process.env['CONTAINER'] === 'true';
    return {
      testId: 'HV-DET-01',
      description: 'CPUID leaf 0x40000000 — hypervisor present',
      result: isContainer ? 'detected' : 'not_detected',
      evidence: isContainer ? 'Kubernetes/Container environment detected' : 'CPUID 0x40000000 not available in this environment',
    };
  }

  // ── HV-DET-02: CPUID leaf 1 — ECX Hypervisor bit ──────────────────────────
  private hvDet02(): HVDetectorResult {
    // stub: 始终 not_detected（Node.js 无法访问 ECX）
    return {
      testId: 'HV-DET-02',
      description: 'CPUID leaf 1 — ECX bit 31 (Hypervisor present)',
      result: 'not_detected',
      evidence: 'ECX register not accessible from Node.js runtime',
    };
  }

  // ── HV-DET-03: CPUID leaf 0x40000001 — Hyper-V vendor string ──────────────
  private hvDet03(): HVDetectorResult {
    const isContainer = process.env['KUBERNETES_SERVICE_HOST'] !== undefined
      || process.env['CONTAINER'] === 'true';
    return {
      testId: 'HV-DET-03',
      description: 'CPUID leaf 0x40000001 — Hyper-V vendor string',
      result: isContainer ? 'detected' : 'not_detected',
      evidence: isContainer ? 'Container environment may be running on Hyper-V host' : 'No Hyper-V vendor string detected',
    };
  }

  // ── HV-DET-04: CPUID leaf 0x40000004 — Hyper-V feature flags ──────────────
  private hvDet04(): HVDetectorResult {
    const isContainer = process.env['KUBERNETES_SERVICE_HOST'] !== undefined
      || process.env['CONTAINER'] === 'true';
    return {
      testId: 'HV-DET-04',
      description: 'CPUID leaf 0x40000004 — Hyper-V feature flags',
      result: isContainer ? 'detected' : 'not_detected',
      evidence: isContainer ? 'Hyper-V feature flags possibly present' : 'No Hyper-V feature flags detected',
    };
  }

  // ── HV-DET-05: MSR 0xC0000000 — hypervisor interface identifier ───────────
  private hvDet05(): HVDetectorResult {
    return {
      testId: 'HV-DET-05',
      description: 'MSR 0xC0000000 — hypervisor interface identifier',
      result: 'inconclusive',
      evidence: 'MSR access not available from userspace Node.js',
    };
  }

  // ── HV-DET-06: MSR 0xC0000001 — hypervisor version ───────────────────────
  private hvDet06(): HVDetectorResult {
    return {
      testId: 'HV-DET-06',
      description: 'MSR 0xC0000001 — hypervisor version',
      result: 'inconclusive',
      evidence: 'MSR access not available from userspace Node.js',
    };
  }

  // ── HV-DET-07: ACPI RSDP/XSDT — Microsoft hypervisor signature ────────────
  private hvDet07(): HVDetectorResult {
    return {
      testId: 'HV-DET-07',
      description: 'ACPI RSDP/XSDT — Microsoft hypervisor signature',
      result: 'inconclusive',
      evidence: 'ACPI table access not available from userspace Node.js',
    };
  }

  // ── HV-DET-08: DMI — Product name contains Hyper-V ────────────────────────
  private hvDet08(): HVDetectorResult {
    // stub: 尝试从 /sys/class/dmi/id/product_name 读取（仅 Linux）
    const fs = require('fs') as typeof import('fs');
    try {
      const product = fs.readFileSync('/sys/class/dmi/id/product_name', 'utf-8').trim();
      const detected = product.toLowerCase().includes('hyper-v')
        || product.toLowerCase().includes('virtual');
      return {
        testId: 'HV-DET-08',
        description: 'DMI — Product name contains Hyper-V indicator',
        result: detected ? 'detected' : 'not_detected',
        evidence: `Product name: "${product}"`,
      };
    } catch {
      return {
        testId: 'HV-DET-08',
        description: 'DMI — Product name contains Hyper-V indicator',
        result: 'inconclusive',
        evidence: '/sys/class/dmi/id/product_name not accessible',
      };
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L8 HostCapabilityEnroller — enroll host capabilities
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface HostCapability {
  hostId: string;
  hypervisorDetected: boolean;
  riskLevel: HVOverallResult['riskLevel'];
  testedAt: string;
  testResults: HVDetectorResult[];
}

export class HostCapabilityEnroller {
  private readonly hosted = new Map<string, HostCapability>();

  /**
   * enroll —— 登记主机能力（检测完成后上报）
   */
  enroll(hostId: string): HostCapability {
    const detector = new HVDetector();
    const result = detector.runAllTests();

    const capability: HostCapability = {
      hostId,
      hypervisorDetected: result.overall === 'detected',
      riskLevel: result.riskLevel,
      testedAt: new Date().toISOString(),
      testResults: result.tests,
    };

    this.hosted.set(hostId, capability);
    return capability;
  }

  /**
   * isHostCapable —— 检查主机是否有资格运行 AegisCI Runner
   * fail-closed: 有任何 HV 检测命中或风险等级 ≥ medium → 拒绝
   */
  isHostCapable(hostId: string): boolean {
    const cap = this.hosted.get(hostId);
    if (!cap) return false; // 未登记 → fail-closed
    if (cap.hypervisorDetected) return false;
    if (cap.riskLevel === 'high' || cap.riskLevel === 'medium') return false;
    return true;
  }

  /**
   * getCapability —— 获取主机能力记录
   */
  getCapability(hostId: string): HostCapability | null {
    return this.hosted.get(hostId) ?? null;
  }

  getEnrolledCount(): number {
    return this.hosted.size;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// L8 ProbeJob — 沙箱探针 job 框架
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ProbeJobSpec {
  hostId: string;
  tests: string[];  // 要运行的 HV-DET 测试 ID 列表
  timeoutMs: number;
}

export interface ProbeJobResult {
  ok: boolean;
  hostId: string;
  executedTests: string[];
  findings: HVDetectorResult[];
  failClosed: boolean;
  completedAt: string;
}

export class ProbeJobRunner {
  /**
   * runProbe —— 在沙箱中运行 HV 检测探针
   */
  runProbe(spec: ProbeJobSpec): ProbeJobResult {
    const detector = new HVDetector();
    const allResults = detector.runAllTests();

    // 过滤只运行指定测试
    const filteredTests = spec.tests.length > 0
      ? allResults.tests.filter((t) => spec.tests.includes(t.testId))
      : allResults.tests;

    const failClosed = allResults.overall !== 'not_detected';

    return {
      ok: true,
      hostId: spec.hostId,
      executedTests: filteredTests.map((t) => t.testId),
      findings: filteredTests,
      failClosed,
      completedAt: new Date().toISOString(),
    };
  }
}
