/**
 * K7-2 · Cedar 规则解析器 单元测试
 */

import { CedarPolicyParserService, type CedarPolicySet } from './cedar-policy-parser.service';

describe('CedarPolicyParserService (K7-2-1)', () => {
  let service: CedarPolicyParserService;

  beforeEach(() => {
    service = new CedarPolicyParserService();
  });

  describe('parseFile', () => {
    it('should return FileParseResult with ok=true', () => {
      // parseFile is private, but we can test via parse()
      const result = service.parse([]);
      expect(result.ok).toBe(true);
    });

    it('should return empty rules for empty file list', () => {
      const result = service.parse([]);
      expect(result.policySet).not.toBeNull();
      expect(result.policySet!.rules).toHaveLength(0);
    });

    it('should return errors when no rules found', () => {
      // Stub parser won't find any rules in empty string
      const result = service.parse(['nonexistent.cedar']);
      expect(result.ok).toBe(false);
      expect(result.errors).toBeDefined();
      expect(result.errors!.length).toBeGreaterThan(0);
    });
  });

  describe('parse', () => {
    it('should return ParseResult with policySet', () => {
      const result = service.parse([]);
      expect(result.ok).toBe(true);
      expect(result.policySet).not.toBeNull();
      expect(result.policySet!.policySetId).toBeTruthy();
    });
  });
});
