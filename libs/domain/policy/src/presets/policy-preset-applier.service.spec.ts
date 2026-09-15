/**
 * K7-2 · PolicyPresetApplierService 单元测试
 */

import { PolicyPresetApplierService } from './policy-preset-applier.service';
import type { CedarPolicySet } from '../parsers/cedar-policy-parser.service';

describe('PolicyPresetApplierService (K7-2-2)', () => {
  let service: PolicyPresetApplierService;

  beforeEach(() => {
    service = new PolicyPresetApplierService();
  });

  const baseRuleset: CedarPolicySet = {
    policySetId: 'ps-base',
    version: '1.0.0',
    rules: [
      { ruleId: 'r1', subject: 'Principal == "agent:ops"', action: 'execute', resource: '*', effect: 'Allow', raw: '' },
      { ruleId: 'r2', subject: 'Principal == "agent:scanner"', action: 'execute', resource: '*', effect: 'Deny', raw: '' },
    ],
    compiledAt: new Date().toISOString(),
  };

  describe('applyPreset', () => {
    it('should allow first-time apply (existing=null)', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-new',
        version: '1.0.0',
        rules: [
          { ruleId: 'r3', subject: 'Principal == "agent:admin"', action: 'execute', resource: '*', effect: 'Allow', raw: '' },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.applyPreset(null, preset);
      expect(result.ok).toBe(true);
      expect(result.direction).toBe('neutral');
    });

    it('should reject preset that removes a Deny rule (relax)', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-relax',
        version: '1.0.0',
        rules: [
          { ruleId: 'r1', subject: 'Principal == "agent:ops"', action: 'execute', resource: '*', effect: 'Allow', raw: '' },
          // r2 (Deny) removed → relax
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.applyPreset(baseRuleset, preset);
      expect(result.ok).toBe(false);
      expect(result.direction).toBe('relax');
      expect(result.errors.some((e) => e.includes('RELAX'))).toBe(true);
    });

    it('should allow preset that adds a Deny rule (tighten)', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-tighten',
        version: '1.0.0',
        rules: [
          ...baseRuleset.rules,
          { ruleId: 'r3', subject: 'Principal == "agent:hacker"', action: 'execute', resource: '*', effect: 'Deny', raw: '' },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.applyPreset(baseRuleset, preset);
      expect(result.ok).toBe(true);
      expect(result.direction).toBe('tighten');
    });

    it('should allow preset with only Allow rule changes (neutral)', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-neutral',
        version: '1.0.0',
        rules: [
          ...baseRuleset.rules,
          { ruleId: 'r3', subject: 'Principal == "agent:new"', action: 'execute', resource: '*', effect: 'Allow', raw: '' },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.applyPreset(baseRuleset, preset);
      expect(result.ok).toBe(true);
      expect(result.direction).toBe('neutral');
    });

    it('should reject preset that changes Deny to Allow (relax)', () => {
      const preset: CedarPolicySet = {
        policySetId: 'ps-relax-allow',
        version: '1.0.0',
        rules: [
          { ruleId: 'r1', subject: 'Principal == "agent:ops"', action: 'execute', resource: '*', effect: 'Allow', raw: '' },
          { ruleId: 'r2', subject: 'Principal == "agent:scanner"', action: 'execute', resource: '*', effect: 'Allow', raw: '' },
        ],
        compiledAt: new Date().toISOString(),
      };
      const result = service.applyPreset(baseRuleset, preset);
      expect(result.ok).toBe(false);
      expect(result.direction).toBe('relax');
    });
  });

  describe('validatePreset', () => {
    it('should pass validation for a well-formed preset', () => {
      const errors = service.validatePreset(baseRuleset);
      expect(errors).toHaveLength(0);
    });

    it('should fail when policySetId is missing', () => {
      const bad = { ...baseRuleset, policySetId: '' };
      const errors = service.validatePreset(bad);
      expect(errors.some((e) => e.includes('policySetId'))).toBe(true);
    });

    it('should fail when rules array is empty', () => {
      const bad = { ...baseRuleset, rules: [] };
      const errors = service.validatePreset(bad);
      expect(errors.some((e) => e.includes('rules'))).toBe(true);
    });
  });
});
