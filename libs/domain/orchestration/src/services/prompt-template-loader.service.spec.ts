/**
 * K7-1 · PromptTemplateLoaderService 单元测试
 */

import * as fs from 'fs';
import * as path from 'path';
import { PromptTemplateLoaderService } from './prompt-template-loader.service';

// mock fs
jest.mock('fs', () => ({
  existsSync: jest.fn(),
  readFileSync: jest.fn(),
  readdirSync: jest.fn(),
}));

const mockFs = jest.mocked(fs);

describe('PromptTemplateLoaderService (K7-1)', () => {
  let service: PromptTemplateLoaderService;

  beforeEach(() => {
    service = new PromptTemplateLoaderService();
    jest.clearAllMocks();
  });

  const SAMPLE_CONTENT = 'Hello {{NAME}}, your risk level is {{RISK}}.';
  const SAMPLE_VAR = '{{NAME}}';

  describe('load', () => {
    it('should load templates from prompts directory', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['hello.md', 'risk.md'] as any);
      mockFs.readFileSync.mockReturnValue(SAMPLE_CONTENT);

      const result = service.load('/mock/pkg', { NAME: 'Alice', RISK: 'G2' });

      expect(result.ok).toBe(true);
      expect(result.templates).toHaveLength(2);
      expect(result.templates[0].content).toContain('Alice');
      expect(result.templates[0].variables).toEqual(['NAME', 'RISK']);
    });

    it('should return errors when prompts directory does not exist', () => {
      mockFs.existsSync.mockReturnValue(false);
      const result = service.load('/mock/pkg');
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('should warn when no .md files found', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['readme.txt'] as any);
      const result = service.load('/mock/pkg');
      expect(result.ok).toBe(true);
      expect(result.warnings.some((w) => w.includes('no prompt templates'))).toBe(true);
    });

    it('should interpolate environment variables', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['tpl.md'] as any);
      mockFs.readFileSync.mockReturnValue('Welcome {{USER}} to {{REGION}}.');
      const result = service.load('/mock/pkg', { USER: 'Bob', REGION: 'CN' });
      expect(result.templates[0].content).toBe('Welcome Bob to CN.');
    });

    it('should leave unused variables as placeholder', () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(['tpl.md'] as any);
      mockFs.readFileSync.mockReturnValue('{{A}} {{B}}');
      const result = service.load('/mock/pkg', { A: 'x' });
      expect(result.templates[0].content).toContain('_UNUSED_B_');
    });
  });

  describe('loadOne', () => {
    it('should fail-fast when required env var is missing', () => {
      mockFs.readFileSync.mockReturnValue('Hello {{NAME}}');
      expect(() => service.loadOne('/mock/tpl.md')).toThrow('missing environment variables');
    });

    it('should return template when all vars provided', () => {
      mockFs.readFileSync.mockReturnValue('Hello {{NAME}}');
      const tpl = service.loadOne('/mock/tpl.md', { NAME: 'Charlie' });
      expect(tpl.content).toBe('Hello Charlie');
      expect(tpl.variables).toEqual(['NAME']);
    });
  });
});
