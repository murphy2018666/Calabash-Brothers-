/**
 * E5-2: EvaluatorBaselineService —— Reviewer 输出与人工评测基准对比
 *
 * 职责：
 * - 存储/加载人工标注的评测基准（ground truth）
 * - 计算 Reviewer 输出与基准的一致性评分
 * - 检测偏差（deviation），触发告警
 *
 * 对应设计文档：
 * - S4 §4.3 E5-2：评测基准集成（一致性评分 ≥80% 为准入）
 */
import { Injectable, Logger } from '@nestjs/common';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 数据类型
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface BaselineFinding {
  /** 文件路径 */
  file: string;
  /** 行号 */
  line?: number;
  /** 严重级别 */
  severity: 'critical' | 'high' | 'medium' | 'low';
  /** 规则 ID */
  ruleId: string;
  /** 问题描述 */
  description: string;
  /** 预期修复建议 */
  suggestion?: string;
}

export interface BaselineResult {
  /** PR 标识 */
  prId: string;
  /** 人工标注的发现列表 */
  findings: BaselineFinding[];
  /** 人工评定的风险级别 */
  expectedRiskLevel: 'G1' | 'G2' | 'G3' | 'G4';
  /** 标注时间 */
  annotatedAt: string;
}

export interface EvaluationScore {
  /** 一致性评分（0~1） */
  consistencyScore: number;
  /** 精确率（True Positive / (True Positive + False Positive)） */
  precision: number;
  /** 召回率（True Positive / (True Positive + False Negative)） */
  recall: number;
  /** F1 分数 */
  f1Score: number;
  /** 风险级别匹配（1=匹配，0=不匹配） */
  riskLevelMatch: boolean;
  /** 偏差告警列表 */
  deviations: Array<{
    type: 'false_positive' | 'false_negative' | 'severity_mismatch' | 'risk_level_mismatch';
    expected: string;
    actual: string;
    finding?: BaselineFinding;
  }>;
}

export interface DeviationAlert {
  prId: string;
  score: number;
  threshold: number;
  deviations: EvaluationScore['deviations'];
  alertLevel: 'warning' | 'critical';
  message: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 配置
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface EvaluatorConfig {
  /** 一致性评分准入阈值（默认 0.8） */
  consistencyThreshold: number;
  /** 偏差告警阈值（低于此值触发 critical） */
  deviationAlertThreshold: number;
}

const DEFAULT_CONFIG: EvaluatorConfig = {
  consistencyThreshold: 0.8,
  deviationAlertThreshold: 0.6,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class EvaluatorBaselineService {
  private readonly logger = new Logger(EvaluatorBaselineService.name);
  private readonly config: EvaluatorConfig;
  private readonly baselineStore = new Map<string, BaselineResult>();

  constructor(config?: Partial<EvaluatorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 基准管理
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 注册评测基准（人工标注结果）。
   */
  registerBaseline(baseline: BaselineResult): void {
    this.baselineStore.set(baseline.prId, baseline);
    this.logger.log(`Registered baseline for pr=${baseline.prId} with ${baseline.findings.length} findings`);
  }

  /**
   * 获取基准。
   */
  getBaseline(prId: string): BaselineResult | null {
    return this.baselineStore.get(prId) ?? null;
  }

  /**
   * 删除基准。
   */
  removeBaseline(prId: string): boolean {
    return this.baselineStore.delete(prId);
  }

  /**
   * 列出所有基准。
   */
  listBaselines(): BaselineResult[] {
    return Array.from(this.baselineStore.values());
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 评估
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 评估 Reviewer 输出与基准的一致性。
   */
  evaluate(prId: string, actualOutput: {
    findings: Array<{
      file: string;
      line?: number;
      severity: string;
      ruleId: string;
      description: string;
      suggestion?: string;
    }>;
    riskLevel: string;
  }): EvaluationScore {
    const baseline = this.baselineStore.get(prId);
    if (!baseline) {
      throw new Error(`Baseline not found for prId=${prId}`);
    }

    const actualFindings = actualOutput.findings;
    const expectedFindings = baseline.findings;

    // 构建匹配索引（按 ruleId + file + description 模糊匹配）
    const matched = this.computeMatching(actualFindings, expectedFindings);
    const tp = matched.tp.length;
    const fp = matched.fp.length;
    const fn = matched.fn.length;

    const precision = fp + tp === 0 ? 0 : tp / (tp + fp);
    const recall = fn + tp === 0 ? 0 : tp / (tp + fn);
    const f1Score = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    // 一致性评分 = F1 × 0.7 + 风险级别匹配 × 0.3
    const riskLevelMatch = actualOutput.riskLevel === baseline.expectedRiskLevel;
    const consistencyScore = f1Score * 0.7 + (riskLevelMatch ? 0.3 : 0);

    // 生成偏差列表
    const deviations: EvaluationScore['deviations'] = [
      ...matched.tp.map((f) => ({
        type: 'true_positive' as const,
        expected: `${f.ruleId}@${f.file}`,
        actual: `${f.ruleId}@${f.file}`,
      })),
      ...matched.fp.map((f) => ({
        type: 'false_positive' as const,
        expected: 'none',
        actual: `${f.ruleId}@${f.file}: ${f.description}`,
        finding: f,
      })),
      ...matched.fn.map((f) => ({
        type: 'false_negative' as const,
        expected: `${f.ruleId}@${f.file}`,
        actual: 'missing',
        finding: f,
      })),
    ];

    if (!riskLevelMatch) {
      deviations.push({
        type: 'risk_level_mismatch',
        expected: baseline.expectedRiskLevel,
        actual: actualOutput.riskLevel,
      });
    }

    // 严重级别不匹配检测
    for (const tpFinding of matched.tp) {
      const expected = expectedFindings.find(
        (ef) => ef.ruleId === tpFinding.ruleId && ef.file === tpFinding.file
      );
      if (expected && expected.severity !== tpFinding.severity) {
        deviations.push({
          type: 'severity_mismatch',
          expected: expected.severity,
          actual: tpFinding.severity,
          finding: expected,
        });
      }
    }

    this.logger.debug(
      `Evaluated pr=${prId}: score=${consistencyScore.toFixed(3)} precision=${precision.toFixed(3)} recall=${recall.toFixed(3)}`
    );

    return {
      consistencyScore: Math.round(consistencyScore * 1000) / 1000,
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      f1Score: Math.round(f1Score * 1000) / 1000,
      riskLevelMatch,
      deviations,
    };
  }

  /**
   * 检查评分是否通过准入阈值。
   */
  passThreshold(score: EvaluationScore): boolean {
    return score.consistencyScore >= this.config.consistencyThreshold;
  }

  /**
   * 生成偏差告警。
   */
  generateDeviationAlert(prId: string, score: EvaluationScore): DeviationAlert | null {
    if (score.consistencyScore >= this.config.deviationAlertThreshold) {
      return null;
    }

    const alertLevel =
      score.consistencyScore >= this.config.consistencyThreshold ? 'warning' : 'critical';
    const deviationCount = score.deviations.filter((d) => d.type !== 'true_positive').length;

    return {
      prId,
      score: score.consistencyScore,
      threshold: this.config.deviationAlertThreshold,
      deviations: score.deviations.filter((d) => d.type !== 'true_positive'),
      alertLevel,
      message: `Evaluator alert for pr=${prId}: consistency=${score.consistencyScore.toFixed(2)} < threshold=${this.config.deviationAlertThreshold}. ${deviationCount} deviations detected.`,
    };
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 私有
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  /**
   * 计算实际发现与期望发现之间的匹配关系。
   * 匹配键：ruleId + file（允许 line 有 ±1 容差）。
   */
  private computeMatching(
    actual: Array<{ ruleId: string; file: string; line?: number; severity: string; description: string }>,
    expected: BaselineFinding[]
  ): { tp: BaselineFinding[]; fp: typeof actual; fn: BaselineFinding[] } {
    const actualKeys = new Set<string>();
    const expectedKeys = new Set<string>();
    const tp: BaselineFinding[] = [];

    for (let i = 0; i < actual.length; i++) {
      const a = actual[i];
      let matched = false;
      for (let j = 0; j < expected.length; j++) {
        if (expectedKeys.has(j)) continue;
        const e = expected[j];
        if (a.ruleId === e.ruleId && this.filesMatch(a.file, e.file)) {
          if (e.line !== undefined && a.line !== undefined && Math.abs(a.line - e.line) > 1) continue;
          actualKeys.add(i);
          expectedKeys.add(j);
          tp.push(e);
          matched = true;
          break;
        }
      }
      if (!matched) {
        // fp 记录原始 actual 条目（转换为 BaselineFinding 格式）
        (tp as any).__fp_indices ??= [];
      }
    }

    const fp = actual.filter((_, i) => !actualKeys.has(i));
    const fn = expected.filter((_, j) => !expectedKeys.has(j));

    return { tp, fp, fn };
  }

  /**
   * 文件名匹配（忽略大小写和路径前缀）。
   */
  private filesMatch(a: string, b: string): boolean {
    const norm = (s: string) => s.toLowerCase().replace(/^.*\//, '');
    return norm(a) === norm(b);
  }
}
