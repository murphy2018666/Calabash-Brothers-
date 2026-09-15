/**
 * K7-3/K3-1 · 收敛偏序判定步骤（DES-11.5）
 *
 * ConvergenceCheckStep —— 调用 ConvergenceChecker SPI 校验技能预设策略
 * 是否为全局基线策略的子集（收紧/等价通过，放宽拒绝）。
 * 该步骤在 policySimulate 之后执行。
 *
 * 类型定义在此文件中，避免跨域导入循环依赖。
 */

import { Injectable, Logger } from '@nestjs/common';
import type { ReviewStepResult } from '../review-pipeline-types';
import type { SkillRecord } from '../skill.service';

/** 技能预设策略集（DES-11.5 输入类型）。 */
export interface CedarPolicySet {
  readonly policySetId: string;
  readonly version: string;
  readonly rules: CedarRule[];
  readonly compiledAt: string;
  [key: string]: unknown;
}

/** 单条 Cedar 规则。 */
export interface CedarRule {
  readonly ruleId: string;
  readonly subject: string;
  readonly action: string;
  readonly resource: string;
  readonly effect: 'Allow' | 'Deny' | 'Forbid';
  readonly condition?: string;
  readonly raw: string;
}

/** 收敛判定结果（DES-11.5 输出类型）。 */
export interface ConvergenceResult {
  readonly ok: boolean;
  readonly direction: 'tighten' | 'neutral' | 'relax';
  readonly conflicts: ConflictInfo[];
  readonly changes: string[];
}

export interface ConflictInfo {
  readonly ruleId: string;
  readonly skillPermission: PermissionScope;
  readonly baselineMatch: PermissionScope | null;
  readonly reason: string;
}

export interface PermissionScope {
  readonly actions: string[];
  readonly resources: string[];
  readonly conditions: string[];
}

/** 收敛检查端口 —— 由控制面注入 DES-11.5 形式化算法实现。 */
export interface ConvergenceChecker {
  checkConvergence(globalBaseline: CedarPolicySet, skillPreset: CedarPolicySet): ConvergenceResult;
}

@Injectable()
export class ConvergenceCheckStep {
  private readonly logger = new Logger(ConvergenceCheckStep.name);

  constructor(private readonly checker: ConvergenceChecker) {}

  async execute(record: SkillRecord): Promise<ReviewStepResult> {
    try {
      const rawPresetObj = (record.manifest as any).policyPreset;
      if (!rawPresetObj || !Array.isArray((rawPresetObj as any).rules)) {
        this.logger.debug(`no policy preset for ${record.skillId} — convergence check neutral`);
        return {
          step: 'convergenceCheck',
          passed: true,
          message: 'no policy preset — convergence check skipped (neutral)',
          evidenceId: `evidence_convergence_${record.skillId}`,
        };
      }
      const skillPreset = rawPresetObj as CedarPolicySet;

      // 全局基线：使用内置空基线（首次装机时无现有策略）
      // 实际部署时由 SpiDefaultsModule 注入全局基线
      const globalBaseline: CedarPolicySet = {
        policySetId: 'default',
        version: '0.0.0',
        rules: [],
        compiledAt: new Date().toISOString(),
      };

      const result = this.checker.checkConvergence(globalBaseline, skillPreset);

      if (!result.ok) {
        this.logger.warn(
          `convergence check FAILED for ${record.skillId}: ${result.conflicts.length} conflict(s)`,
        );
        return {
          step: 'convergenceCheck',
          passed: false,
          message: `convergence check failed: ${result.conflicts.map((c) => c.ruleId).join(', ')} — ${result.direction}`,
          evidenceId: `evidence_convergence_${record.skillId}`,
        };
      }

      this.logger.debug(`convergence check PASSED (${result.direction}) for ${record.skillId}`);
      return {
        step: 'convergenceCheck',
        passed: true,
        message: `convergence OK (${result.direction}): ${result.changes.join('; ')}`,
        evidenceId: `evidence_convergence_${record.skillId}`,
      };
    } catch (err) {
      this.logger.error(
        `convergence check error for ${record.skillId}: ${(err as Error).message} — deferring to manual review`,
      );
      return {
        step: 'convergenceCheck',
        passed: false,
        message: `convergence check unavailable: ${(err as Error).message} — pending manual review`,
        evidenceId: `evidence_convergence_${record.skillId}`,
      };
    }
  }
}
