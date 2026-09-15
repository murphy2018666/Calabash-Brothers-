/**
 * K3-1 · DES-11.5 收敛偏序判定
 *
 * 形式化算法（DES-11.5 §2）：
 * 1. 将全局基线策略集 G 与技能预设 S 分别提取 permit 规则集合 Permit(G) 和 Permit(S)
 * 2. 对 Permit(S) 中每条 permit 规则 s，检查是否存在 Permit(G) 中某条规则 g，
 *    使得：s.actions ⊆ g.actions ∧ s.resources ⊆ g.resources ∧ s.conditions ⊇ g.conditions
 *    （即 s 的授权范围不超过 g）
 * 3. 若存在任何 permit 规则无法匹配 → reject（放宽，RELAX）
 * 4. Forbid/Deny 规则不受限（技能可额外禁止更多操作）
 * 5. 全部通过 → allow（收紧或等价，TIGHTEN/NEUTRAL）
 */

import { Injectable, Logger } from '@nestjs/common';
import type { CedarPolicySet, CedarRule } from '../parsers/cedar-policy-parser.service';

export interface ConvergenceResult {
  /** 是否通过收敛判定 */
  readonly ok: boolean;
  /** 判定方向 */
  readonly direction: 'tighten' | 'neutral' | 'relax';
  /** 冲突规则列表（仅当 ok=false 时有值） */
  readonly conflicts: ConflictInfo[];
  /** 变更描述 */
  readonly changes: string[];
}

export interface ConflictInfo {
  readonly ruleId: string;
  /** 技能预设中该规则的授权范围 */
  readonly skillPermission: PermissionScope;
  /** 全局基线中最接近的匹配规则（可能为 null 表示无匹配） */
  readonly baselineMatch: PermissionScope | null;
  readonly reason: string;
}

export interface PermissionScope {
  readonly actions: string[];
  readonly resources: string[];
  readonly conditions: string[];
}

@Injectable()
export class ConvergenceCheckerService {
  private readonly logger = new Logger(ConvergenceCheckerService.name);

  /**
   * 执行收敛偏序判定。
   * @param globalBaseline 全局基线策略（PolicyEngine 当前已装机规则）
   * @param skillPreset 技能预设策略（待装机）
   */
  checkConvergence(
    globalBaseline: CedarPolicySet,
    skillPreset: CedarPolicySet,
  ): ConvergenceResult {
    const permitG = this.extractPermitRules(globalBaseline);
    const permitS = this.extractPermitRules(skillPreset);

    const conflicts: ConflictInfo[] = [];
    const changes: string[] = [];
    let hasTighten = false;

    for (const ruleS of permitS) {
      const match = this.findMatchingBaselineRule(ruleS, permitG);
      if (!match) {
        // 技能预设中存在全局基线未覆盖的 permit 规则 → 放宽，拒绝
        conflicts.push({
          ruleId: ruleS.ruleId,
          skillPermission: this.toPermissionScope(ruleS),
          baselineMatch: null,
          reason: `skill permit rule "${ruleS.ruleId}" authorizes actions/resources not covered by global baseline`,
        });
      } else {
        // 找到匹配，检查是否为收紧（条件更严格）
        const scopeS = this.toPermissionScope(ruleS);
        const scopeG = this.toPermissionScope(match);
        if (this.isStricter(scopeS, scopeG)) {
          hasTighten = true;
          changes.push(`rule ${ruleS.ruleId}: tightened (stricter conditions)`);
        }
      }
    }

    // 统计新增 deny/forbid 规则（收紧）
    const existingIds = new Set(globalBaseline.rules.map((r) => r.ruleId));
    for (const rule of skillPreset.rules) {
      if (!existingIds.has(rule.ruleId) && (rule.effect === 'Deny' || rule.effect === 'Forbid')) {
        hasTighten = true;
        changes.push(`added ${rule.effect} rule: ${rule.ruleId}`);
      }
    }

    if (conflicts.length > 0) {
      this.logger.warn(
        `convergence check FAILED for preset ${skillPreset.policySetId}: ${conflicts.length} conflict(s)`,
      );
      return {
        ok: false,
        direction: 'relax',
        conflicts,
        changes,
      };
    }

    if (hasTighten) {
      this.logger.debug(`convergence check PASSED (tighten) for preset ${skillPreset.policySetId}`);
      return {
        ok: true,
        direction: 'tighten',
        conflicts: [],
        changes: [`convergence OK (${skillPreset.policySetId}): ${changes.join('; ')}`],
      };
    }

    this.logger.debug(`convergence check PASSED (neutral) for preset ${skillPreset.policySetId}`);
    return {
      ok: true,
      direction: 'neutral',
      conflicts: [],
      changes: ['convergence OK — preset equivalent to global baseline'],
    };
  }

  /** 提取所有 Allow 规则（permit 规则集合）。 */
  private extractPermitRules(policySet: CedarPolicySet): CedarRule[] {
    return policySet.rules.filter((r) => r.effect === 'Allow');
  }

  /**
   * 寻找全局基线中与 skill 规则匹配的 permit 规则。
   * 匹配条件：s.actions ⊆ g.actions ∧ s.resources ⊆ g.resources ∧ s.conditions ⊇ g.conditions
   */
  private findMatchingBaselineRule(
    ruleS: CedarRule,
    permitG: CedarRule[],
  ): CedarRule | null {
    for (const ruleG of permitG) {
      if (this.matchesBaseline(ruleS, ruleG)) {
        return ruleG;
      }
    }
    return null;
  }

  /**
   * 判定 skill 规则 s 的授权范围是否不超过基线规则 g。
   * s.actions ⊆ g.actions ∧ s.resources ⊆ g.resources ∧ s.conditions ⊇ g.conditions
   */
  private matchesBaseline(ruleS: CedarRule, ruleG: CedarRule): boolean {
    // actions 子集检查
    const actionsS = this.parseActions(ruleS.action);
    const actionsG = this.parseActions(ruleG.action);
    if (!this.isSubset(actionsS, actionsG)) return false;

    // resources 子集检查（支持通配符语义）
    const resourcesS = this.parseResources(ruleS.resource);
    const resourcesG = this.parseResources(ruleG.resource);
    if (!this.isResourceSubset(resourcesS, resourcesG)) return false;

    // conditions 超集检查（基线条件更宽松，技能条件更严格）
    const conditionsS = this.parseConditions(ruleS.condition);
    const conditionsG = this.parseConditions(ruleG.condition);
    if (!this.isSuperset(conditionsS, conditionsG)) return false;

    return true;
  }

  /**
   * 资源子集检查——支持通配符语义。
   * 如果 baseline resource 包含 '*' 或前缀通配符（如 'data:*'），则匹配所有子资源。
   */
  private isResourceSubset(resourcesS: string[], resourcesG: string[]): boolean {
    if (resourcesS.length === 0) return true;
    // 如果基线有全匹配通配符，则直接通过
    if (resourcesG.includes('*')) return true;
    // 检查每条 skill 资源是否被基线某条资源覆盖
    return resourcesS.every((sRes) =>
      resourcesG.some((gRes) => {
        if (sRes === gRes) return true;
        // 通配符前缀匹配：gRes='data:*' 匹配 sRes='data:public'
        if (gRes.endsWith(':*') && sRes.startsWith(gRes.slice(0, -1))) return true;
        return false;
      }),
    );
  }

  private isSubset<A>(subset: A[], superset: A[]): boolean {
    if (subset.length === 0) return true;
    const set = new Set(superset);
    return subset.every((item) => set.has(item));
  }

  private isSuperset<A>(superset: A[], subset: A[]): boolean {
    if (subset.length === 0) return true;
    const set = new Set(superset);
    return subset.every((item) => set.has(item));
  }

  /** 判定 skill 规则是否比基线规则更严格（用于标记 tighten）。 */
  private isStricter(scopeS: PermissionScope, scopeG: PermissionScope): boolean {
    // 条件更多 = 更严格
    return scopeS.conditions.length > scopeG.conditions.length;
  }

  private toPermissionScope(rule: CedarRule): PermissionScope {
    return {
      actions: this.parseActions(rule.action),
      resources: this.parseResources(rule.resource),
      conditions: this.parseConditions(rule.condition),
    };
  }

  /** 解析 action 字段为动作列表（支持 "action1,action2" 逗号分隔格式）。 */
  private parseActions(action: string): string[] {
    return action.split(',').map((a) => a.trim()).filter(Boolean);
  }

  /** 解析 resource 字段为资源列表（* 表示全匹配）。 */
  private parseResources(resource: string): string[] {
    return resource === '*' ? ['*'] : resource.split(',').map((r) => r.trim()).filter(Boolean);
  }

  /** 解析 condition 字段为条件列表。 */
  private parseConditions(condition: string | undefined): string[] {
    if (!condition) return [];
    return condition.split('&&').map((c) => c.trim()).filter(Boolean);
  }
}
