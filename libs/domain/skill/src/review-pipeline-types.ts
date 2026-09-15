/**
 * K3-1 · 评审流水线步骤接口 + 类型定义（7 步）
 *
 * 步骤顺序：签名验证 → Schema lint → SBOM 扫描 → Prompt 注入扫描
 *         → 策略 simulate → 收敛偏序判定 → 合规门禁
 * 结果聚合 → Audit WORM 固化
 */

import type { SkillRecord } from './skill.service';

export type ReviewStepName =
  | 'signature'
  | 'schemaLint'
  | 'sbomScan'
  | 'promptInjection'
  | 'policySimulate'
  | 'convergenceCheck'
  | 'complianceGate';

export interface ReviewStepResult {
  /** 步骤名 */
  readonly step: ReviewStepName;
  /** 是否通过 */
  readonly passed: boolean;
  /** 详情 / 错误消息 */
  readonly message: string;
  /** 证据 ID（用于 WORM 审计追溯） */
  readonly evidenceId?: string;
  /** 追踪 span ID */
  readonly traceSpanId?: string;
}

export interface ReviewPipelineResult {
  readonly skillId: string;
  readonly passed: boolean;
  readonly steps: ReviewStepResult[];
  readonly reviewedAt: string;
  readonly auditEntryId?: string;
}

/** 评审流水线上下文 —— 传入各步骤，步骤返回结果并更新上下文。 */
export interface ReviewContext {
  readonly record: SkillRecord;
  readonly findings: ReviewStepResult[];
}
