/**
 * K7-2 · PolicyPresetApplierService —— 将 PolicyPack 的策略预设按偏序比较算法
 * （DES-11.5）校验后落位至 PolicyEngine。
 *
 * 偏序比较规则（DES-11.5）：
 * - 收紧（more restrictive）：新增 Deny 规则 / 缩窄条件 → 允许
 * - 放宽（less restrictive）：移除 Deny 规则 / 扩宽条件 → 拒绝
 * - 等价：允许
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CedarPolicySet } from '../parsers/cedar-policy-parser.service';

export interface PresetApplyResult {
  ok: boolean;
  direction: 'tighten' | 'relax' | 'neutral';
  changes: string[];
  errors: string[];
}

export interface PolicyChange {
  type: 'add' | 'remove' | 'modify';
  ruleId: string;
  description: string;
}

@Injectable()
export class PolicyPresetApplierService {
  private readonly logger = new Logger(PolicyPresetApplierService.name);

  /**
   * 应用策略预设 —— 校验偏序后落位。
   * @param existing 现有 PolicyEngine 中的规则集（可为 null 表示首次落位）
   * @param preset 待落位的 PolicyPack 策略预设
   */
  applyPreset(
    existing: CedarPolicySet | null,
    preset: CedarPolicySet,
  ): PresetApplyResult {
    if (!existing) {
      // 首次落位：直接允许
      this.logger.debug(`first-time policy preset apply: ${preset.policySetId}`);
      return {
        ok: true,
        direction: 'neutral',
        changes: [`initial load: ${preset.rules.length} rules`],
        errors: [],
      };
    }

    // 构建两个 Map 用于比较
    const existingMap = new Map(existing.rules.map((r) => [r.ruleId, r]));
    const presetMap = new Map(preset.rules.map((r) => [r.ruleId, r]));
    const changes: string[] = [];
    let hasRelax = false;
    let hasTighten = false;

    // 遍历 existing.rules，检查每条规则在 preset 中的变化
    for (const rule of existing.rules) {
      const inPreset = presetMap.get(rule.ruleId);
      if (!inPreset) {
        // 规则被移除：移除 Deny = relax（更不安全）
        if (rule.effect === 'Deny') {
          hasRelax = true;
          changes.push(`removed Deny rule (RELAX — blocked): ${rule.ruleId}`);
        } else {
          changes.push(`removed Allow rule: ${rule.ruleId}`);
        }
      } else if (inPreset.effect !== rule.effect) {
        // 规则 effect 发生变化
        if (rule.effect === 'Deny' && inPreset.effect === 'Allow') {
          // Deny → Allow = relax（更不安全）
          hasRelax = true;
          changes.push(`changed ${rule.ruleId} Deny→Allow (RELAX — blocked)`);
        } else if (rule.effect === 'Allow' && inPreset.effect === 'Deny') {
          // Allow → Deny = tighten（更安全）
          hasTighten = true;
          changes.push(`changed ${rule.ruleId} Allow→Deny (tighten)`);
        }
      }
    }

    // 遍历 preset.rules，检查新增规则
    for (const rule of preset.rules) {
      if (!existingMap.has(rule.ruleId)) {
        if (rule.effect === 'Deny') {
          hasTighten = true;
          changes.push(`added Deny rule: ${rule.ruleId}`);
        } else {
          changes.push(`added Allow rule: ${rule.ruleId}`);
        }
      }
    }

    // 偏序判定：任何放宽操作 → 拒绝
    if (hasRelax) {
      return {
        ok: false,
        direction: 'relax',
        changes,
        errors: ['RELAX: policy preset relaxes global baseline — rejected by DES-11.5偏序比较'],
      };
    }

    if (hasTighten) {
      return {
        ok: true,
        direction: 'tighten',
        changes,
        errors: [],
      };
    }

    return {
      ok: true,
      direction: 'neutral',
      changes: ['no effective policy change'],
      errors: [],
    };
  }

  /**
   * 校验策略预设的 schema 合法性。
   */
  validatePreset(preset: CedarPolicySet): string[] {
    const errors: string[] = [];
    if (!preset.policySetId) errors.push('policySetId is required');
    if (!preset.version) errors.push('version is required');
    if (!Array.isArray(preset.rules) || preset.rules.length === 0) {
      errors.push('rules must be a non-empty array');
    }
    for (const rule of preset.rules ?? []) {
      if (!rule.subject) errors.push(`rule ${rule.ruleId}: subject is required`);
      if (!rule.action) errors.push(`rule ${rule.ruleId}: action is required`);
      if (!rule.effect || !['Allow', 'Deny', 'Forbid'].includes(rule.effect)) {
        errors.push(`rule ${rule.ruleId}: invalid effect ${rule.effect}`);
      }
    }
    return errors;
  }
}
