/**
 * 流水线合规门禁集成服务（NFR-S4 / T-15-02）
 *
 * 将合规自查报告集成到 CI/CD Pipeline 门禁决策依据中。
 * 在 Run 创建时自动触发合规扫描，将覆盖率结果写入门禁证据链。
 *
 * 对应文档：
 * - S13 §10.4 NFR-S4（T-15-02）
 * - DES-6 HITL 审批工作流（门禁 evidence 字段）
 */
import { Injectable, Logger } from '@nestjs/common';
import type { GatePassedPayload } from '@aegisci/domain/pipeline/events/pipeline-events';
import {
  ComplianceCheckService,
  type ComplianceReport,
  type CoverageStatus,
} from './compliance-check.service';

/**
 * ComplianceGateDecision —— 合规门禁裁决结果
 */
export interface ComplianceGateDecision {
  /** 覆盖率是否达到阈值 */
  passed: boolean;
  /** 实际覆盖率（百分比） */
  coverageRate: number;
  /** 覆盖率阈值（百分比） */
  threshold: number;
  /** 未覆盖项列表 */
  gaps: Array<{ id: string; name: string; status: CoverageStatus; gapAnalysis?: string }>;
  /** 门禁证据字符串（供 GatePassedPayload.evidence 使用） */
  evidence: string;
}

@Injectable()
export class CompliancePipelineIntegrationService {
  private readonly logger = new Logger(CompliancePipelineIntegrationService.name);

  constructor(private readonly complianceService: ComplianceCheckService) {}

  /**
   * evaluateGate —— 评估合规门禁裁决
   *
   * 生成最新合规报告并判断是否满足最低覆盖率阈值。
   *
   * @param thresholdPercent 覆盖率阈值（默认 80）
   */
  evaluateGate(thresholdPercent = 80): ComplianceGateDecision {
    const report = this.complianceService.generateReport();
    const coverageRate = report.overallCoverageRate;
    const passed = coverageRate >= thresholdPercent;
    const gaps = report.gaps.map(item => ({
      id: item.id,
      name: item.name,
      status: item.status,
      gapAnalysis: item.gapAnalysis,
    }));

    const evidence = `等保三级合规自查：覆盖率 ${coverageRate}%（阈值 ${thresholdPercent}%），${passed ? '通过' : '未通过'}；覆盖项 ${report.total.covered}/${report.items.length}，部分覆盖 ${report.total.partial}，未覆盖 ${report.total.uncovered}`;

    this.logger.log(`Compliance gate: rate=${coverageRate}% threshold=${thresholdPercent}% ${passed ? 'PASSED' : 'BLOCKED'}`);

    return { passed, coverageRate, threshold: thresholdPercent, gaps, evidence };
  }

  /**
   * buildEvidenceArray —— 将门禁裁决转化为证据数组
   *
   * 适配 GatePassedPayload.evidence 字段（string[]）。
   * 未通过时返回空数组（门禁阻断）。
   */
  buildEvidenceArray(decision: ComplianceGateDecision): string[] {
    if (!decision.passed) {
      return [];
    }
    return [decision.evidence];
  }

  /**
   * formatGateBlockReason —— 生成门禁阻断原因说明
   *
   * 供 GateBlockedPayload.reason 使用。
   */
  formatGateBlockReason(decision: ComplianceGateDecision): string {
    return `合规门禁未通过：覆盖率 ${decision.coverageRate}% 低于阈值 ${decision.threshold}%。未覆盖项：${decision.gaps.map(g => `${g.id}(${g.name}/${g.status})`).join(', ')}`;
  }

  /**
   * getReport —— 直接获取最新合规报告
   *
   * 供前端仪表盘或 API 查询使用。
   */
  getReport(): ComplianceReport {
    return this.complianceService.generateReport();
  }

  /**
   * scanCodebase —— 扫描指定文件内容并返回合规标记集合
   *
   * 供运行时增量扫描使用。
   */
  scanCodebase(fileContents: Record<string, string>): Map<string, Set<string>> {
    return this.complianceService.scanFiles(fileContents);
  }
}
