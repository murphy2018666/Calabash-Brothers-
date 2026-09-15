/**
 * E5-1: ReviewerPromptService 单元测试
 *
 * 覆盖：
 * - 提示生成（系统提示 + 用户提示）
 * - 安全规则集注入
 * - 自定义规则增删
 * - 输出验证（schema 合规性）
 * - traceSpanId 传播
 */
import { Test } from '@nestjs/testing';
import { ReviewerPromptService } from './reviewer-prompt.service';
import type { ReviewerPromptContext, SecurityRule } from './reviewer-prompt.service';

describe('E5-1 ReviewerPromptService', () => {
  let service: ReviewerPromptService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [ReviewerPromptService],
    }).compile();
    service = moduleRef.get<ReviewerPromptService>(ReviewerPromptService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 提示生成
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('generates system prompt with security rules', () => {
    const prompt = service.generate(
      makeContext(),
      'span-123',
    );

    expect(prompt.systemPrompt).toContain('Reviewer-Agent');
    expect(prompt.systemPrompt).toContain('R-SEC-001');
    expect(prompt.systemPrompt).toContain('禁止硬编码凭证');
    expect(prompt.traceSpanId).toBe('span-123');
  });

  it('generates user prompt with PR context', () => {
    const context = makeContext({
      prTitle: 'Fix auth bug',
      changedFiles: ['src/auth.ts', 'src/middleware.ts'],
    });
    const prompt = service.generate(context, 'span-456');

    expect(prompt.userPrompt).toContain('Fix auth bug');
    expect(prompt.userPrompt).toContain('src/auth.ts');
    expect(prompt.userPrompt).toContain('src/middleware.ts');
  });

  it('includes existing findings in user prompt', () => {
    const prompt = service.generate(
      makeContext({ existingFindings: 'Previous XSS vulnerability' }),
      'span-789',
    );

    expect(prompt.userPrompt).toContain('Previous XSS vulnerability');
  });

  it('includes extra context when provided', () => {
    const prompt = service.generate(
      makeContext({ extraContext: 'Customer data involved' }),
      'span-ext',
    );

    expect(prompt.userPrompt).toContain('Customer data involved');
  });

  it('output schema has required fields', () => {
    const prompt = service.generate(makeContext(), 'span-schema');

    expect(prompt.outputSchema.required).toContain('findings');
    expect(prompt.outputSchema.required).toContain('summary');
    expect(prompt.outputSchema.required).toContain('riskLevel');
    expect(prompt.outputSchema.required).toContain('traceSpanId');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 安全规则管理
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('has 6 default security rules', () => {
    const rules = service.getAllRules();
    expect(rules).toHaveLength(6);
    expect(rules[0].ruleId).toBe('R-SEC-001');
  });

  it('addRule appends custom rule', () => {
    const customRule: SecurityRule = {
      ruleId: 'R-CUSTOM-001',
      description: 'Custom rule',
      severity: 'low',
      check: 'Custom check',
    };

    service.addRule(customRule);
    const rules = service.getAllRules();
    expect(rules).toHaveLength(7);
    expect(rules[6].ruleId).toBe('R-CUSTOM-001');
  });

  it('removeRule removes custom rule', () => {
    service.addRule({ ruleId: 'R-TEMP', description: 'temp', severity: 'low', check: 't' });
    expect(service.getAllRules()).toHaveLength(7);

    service.removeRule('R-TEMP');
    expect(service.getAllRules()).toHaveLength(6);
  });

  it('removeRule returns false for non-existent rule', () => {
    expect(service.removeRule('R-NONEXIST')).toBe(false);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 输出验证
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('validates correct output structure', () => {
    const validOutput = {
      findings: [
        { file: 'src/a.ts', line: 10, severity: 'high', ruleId: 'R-SEC-001', description: 'Hardcoded password' },
      ],
      summary: 'Found 1 critical issue',
      riskLevel: 'G3',
      traceSpanId: 'span-valid',
    };

    const issues = service.validateOutput(validOutput);
    expect(issues).toEqual([]);
  });

  it('detects missing required fields', () => {
    const incompleteOutput = {
      findings: [],
      summary: 'test',
      // 缺少 riskLevel 和 traceSpanId
    };

    const issues = service.validateOutput(incompleteOutput);
    expect(issues).toContain('Missing required field: riskLevel');
    expect(issues).toContain('Missing required field: traceSpanId');
  });

  it('detects invalid riskLevel', () => {
    const output = {
      findings: [],
      summary: 'test',
      riskLevel: 'G5',
      traceSpanId: 'span-x',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('Invalid riskLevel'))).toBe(true);
  });

  it('detects finding with missing required fields', () => {
    const output = {
      findings: [{ file: 'x', severity: 'high' }], // 缺少 ruleId 和 description
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'span-y',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('Finding[0] missing'))).toBe(true);
  });

  it('detects short traceSpanId', () => {
    const output = {
      findings: [],
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'ab', // 太短
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('traceSpanId too short'))).toBe(true);
  });

  it('allows valid traceSpanId with sufficient length', () => {
    const output = {
      findings: [],
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'span-abc-123',
    };

    const issues = service.validateOutput(output);
    expect(issues).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 辅助函数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function makeContext(overrides: Partial<ReviewerPromptContext> = {}): ReviewerPromptContext {
  return {
    prTitle: 'Test PR',
    prDescription: 'Test description',
    changedFiles: ['src/test.ts'],
    riskLevel: 'G2',
    ...overrides,
  };
}
