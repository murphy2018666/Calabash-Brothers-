/**
 * K3-1 · ConvergenceCheckerService 单元测试（DES-11.5 形式化算法）
 * 覆盖 ≥10 个测试用例
 */

import { ConvergenceCheckerService } from './convergence-checker.service';
import type { CedarPolicySet } from '../index';

describe('ConvergenceCheckerService (K3-1)', () => {
  let service: ConvergenceCheckerService;

  beforeEach(() => {
    service = new ConvergenceCheckerService();
  });

  const baseline: CedarPolicySet = {
    policySetId: 'global-baseline',
    version: '1.0.0',
    rules: [
      {
        ruleId: 'allow-read',
        subject: 'Principal == "agent:reader"',
        action: 'read',
        resource: 'data:*',
        effect: 'Allow',
        condition: 'request.authenticated == true',
        raw: '',
      },
      {
        ruleId: 'allow-write',
        subject: 'Principal == "agent:writer"',
        action: 'write',
        resource: 'data:sensitive',
        effect: 'Allow',
        condition: 'request.authenticated == true && user.role == "admin"',
        raw: '',
      },
      {
        ruleId: 'deny-admin',
        subject: 'Principal == "agent:hacker"',
        action: 'admin',
        resource: '*',
        effect: 'Deny',
        raw: '',
      },
    ],
    compiledAt: new Date().toISOString(),
  };

  describe('checkConvergence — permit-subset 通过场景', () => {
    it('should pass when skill permit is exact subset of baseline (same action/resource/condition)', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-subset',
        version: '1.0.0',
        rules: [
          {
            ruleId: 'allow-read-narrow',
            subject: 'Principal == "agent:reader"',
            action: 'read',
            resource: 'data:public',
            effect: 'Allow',
            condition: 'request.authenticated == true && data.classification == "public"',
            raw: '',
          },
        ],
        compiledAt: new Date().toISOString(),
      };
      // data:public ⊆ data:*，条件更严格（超集）→ 通过
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(true);
      expect(result.direction).toBe('tighten');
      expect(result.conflicts).toHaveLength(0);
    });

    it('should reject when skill permit drops baseline conditions (expands scope)', () => {
      // 空条件无法覆盖基线的两个条件 → 视为 relax
      const preset: CedarPolicySet = {
        policySetId: 'ps-loose',
        version: '1.0.0',
        rules: [
          {
            ruleId: 'allow-write-relaxed',
            subject: 'Principal == "agent:writer"',
            action: 'write',
            resource: 'data:sensitive',
            effect: 'Allow',
            raw: '',
          },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(false);
      expect(result.direction).toBe('relax');
    });

    it('should pass when skill adds only Deny/Forbid rules (no new permits)', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-deny-only',
        version: '1.0.0',
        rules: [
          {
            ruleId: 'deny-exec',
            subject: 'Principal == "agent:*"',
            action: 'execute',
            resource: 'system:core',
            effect: 'Deny',
            raw: '',
          },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(true);
      expect(result.direction).toBe('tighten');
      expect(result.conflicts).toHaveLength(0);
    });

    it('should pass for empty skill preset (neutral — no new permits added)', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-empty',
        version: '1.0.0',
        rules: [],
        compiledAt: new Date().toISOString(),
      };
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(true);
      expect(result.direction).toBe('neutral');
    });
  });

  describe('checkConvergence — permit-not-subset 拒绝场景', () => {
    it('should reject when skill permit adds a new action not in baseline', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-new-action',
        version: '1.0.0',
        rules: [
          {
            ruleId: 'allow-delete',
            subject: 'Principal == "agent:reader"',
            action: 'delete',
            resource: 'data:*',
            effect: 'Allow',
            condition: 'request.authenticated == true',
            raw: '',
          },
        ],
        compiledAt: new Date().toISOString(),
      };
      // delete ∉ {read} → 无匹配 → 拒绝
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(false);
      expect(result.direction).toBe('relax');
      expect(result.conflicts).toHaveLength(1);
      expect(result.conflicts[0].ruleId).toBe('allow-delete');
    });

    it('should reject when skill permit adds a new resource scope not in baseline', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-new-resource',
        version: '1.0.0',
        rules: [
          {
            ruleId: 'allow-read-all',
            subject: 'Principal == "agent:reader"',
            action: 'read',
            resource: 'system:config',
            effect: 'Allow',
            condition: 'request.authenticated == true',
            raw: '',
          },
        ],
        compiledAt: new Date().toISOString(),
      };
      // system:config ∉ {data:*} → 无匹配 → 拒绝
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(false);
      expect(result.conflicts).toHaveLength(1);
    });

    it('should reject when skill permit has looser condition than baseline (expands scope)', () => {
      // skill 去掉了 admin 要求，属于 relax
      const preset: CedarPolicySet = {
        policySetId: 'ps-loose-explicit',
        version: '1.0.0',
        rules: [
          {
            ruleId: 'allow-write-relaxed',
            subject: 'Principal == "agent:writer"',
            action: 'write',
            resource: 'data:sensitive',
            effect: 'Allow',
            condition: 'request.authenticated == true',
            raw: '',
          },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(false);
      expect(result.direction).toBe('relax');
    });

    it('should report multiple conflicts when multiple permit rules have no match', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-multi-conflict',
        version: '1.0.0',
        rules: [
          {
            ruleId: 'allow-exec',
            subject: 'Principal == "agent:runner"',
            action: 'execute',
            resource: 'system:core',
            effect: 'Allow',
            raw: '',
          },
          {
            ruleId: 'allow-admin',
            subject: 'Principal == "agent:super"',
            action: 'admin',
            resource: 'system:*',
            effect: 'Allow',
            raw: '',
          },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(false);
      expect(result.conflicts).toHaveLength(2);
    });
  });

  describe('checkConvergence — Forbid 规则不受限', () => {
    it('should allow Forbid rules even if not in baseline', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-forbid',
        version: '1.0.0',
        rules: [
          {
            ruleId: 'forbid-secret',
            subject: 'Principal == "agent:any"',
            action: 'access',
            resource: 'secrets:*',
            effect: 'Forbid',
            raw: '',
          },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(true);
    });
  });

  describe('checkConvergence — 边界条件', () => {
    it('should pass when skill permit uses wildcard action matching baseline action', () => {
      // 基线 action=read，skill action=read（完全匹配）→ 通过
      const preset: CedarPolicySet = {
        policySetId: 'ps-exact-match',
        version: '1.0.0',
        rules: [
          {
            ruleId: 'allow-read-exact',
            subject: 'Principal == "agent:reader"',
            action: 'read',
            resource: 'data:*',
            effect: 'Allow',
            condition: 'request.authenticated == true',
            raw: '',
          },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(true);
      expect(result.direction).toBe('neutral');
    });

    it('should reject when baseline has no permit rules at all', () => {
      const emptyBaseline: CedarPolicySet = {
        policySetId: 'baseline-empty',
        version: '1.0.0',
        rules: [
          { ruleId: 'deny-all', subject: '*', action: '*', resource: '*', effect: 'Deny', raw: '' },
        ],
        compiledAt: new Date().toISOString(),
      };
      const preset: CedarPolicySet = {
        policySetId: 'ps-first-allow',
        version: '1.0.0',
        rules: [
          { ruleId: 'allow-something', subject: '*', action: 'read', resource: '*', effect: 'Allow', raw: '' },
        ],
        compiledAt: new Date().toISOString(),
      };
      // 基线无 Allow 规则，skill 的 Allow 无法匹配 → 拒绝
      const result = service.checkConvergence(emptyBaseline, preset);
      expect(result.ok).toBe(false);
    });

    it('should return changes describing tighten actions', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-tighten',
        version: '1.0.0',
        rules: [
          {
            ruleId: 'allow-read',
            subject: 'Principal == "agent:reader"',
            action: 'read',
            resource: 'data:*',
            effect: 'Allow',
            condition: 'request.authenticated == true && audit.traced == true',
            raw: '',
          },
          {
            ruleId: 'deny-extra',
            subject: 'Principal == "agent:reader"',
            action: 'write',
            resource: 'data:secrets',
            effect: 'Deny',
            raw: '',
          },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.checkConvergence(baseline, preset);
      expect(result.ok).toBe(true);
      expect(result.changes.some((c) => c.includes('tightened'))).toBe(true);
      expect(result.changes.some((c) => c.includes('deny-extra'))).toBe(true);
    });
  });
});
