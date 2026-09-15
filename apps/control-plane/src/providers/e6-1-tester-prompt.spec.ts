/**
 * E6-1: TesterPromptService 单元测试
 *
 * 覆盖：
 * - 提示生成（系统提示 + 用户提示）
 * - 测试规则集注入
 * - 自定义规则增删
 * - 输出验证（schema 合规性）
 * - traceSpanId 传播
 */
import { Test } from '@nestjs/testing';
import { TesterPromptService } from './tester-prompt.service';

describe('E6-1 TesterPromptService', () => {
  let service: TesterPromptService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [TesterPromptService],
    }).compile();
    service = moduleRef.get<TesterPromptService>(TesterPromptService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 提示生成
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('generates system prompt with test rules', () => {
    const prompt = service.generate(makeContext(), 'span-123');

    expect(prompt.systemPrompt).toContain('Tester-Agent');
    expect(prompt.systemPrompt).toContain('R-TEST-001');
    expect(prompt.systemPrompt).toContain('核心功能回归测试');
    expect(prompt.traceSpanId).toBe('span-123');
  });

  it('generates user prompt with PR context', () => {
    const context = makeContext({
      prTitle: 'Add auth feature',
      changedFiles: ['src/auth.ts', 'src/tests/auth.spec.ts'],
    });
    const prompt = service.generate(context, 'span-456');

    expect(prompt.userPrompt).toContain('Add auth feature');
    expect(prompt.userPrompt).toContain('src/auth.ts');
    expect(prompt.userPrompt).toContain('src/tests/auth.spec.ts');
  });

  it('includes existing test results in user prompt', () => {
    const prompt = service.generate(
      makeContext({ existingTestResults: 'Unit tests passing, coverage 85%' }),
      'span-789',
    );

    expect(prompt.userPrompt).toContain('Unit tests passing, coverage 85%');
  });

  it('includes coverage requirement in user prompt', () => {
    const prompt = service.generate(
      makeContext({ coverageRequirement: '90% line coverage required' }),
      'span-cov',
    );

    expect(prompt.userPrompt).toContain('90% line coverage required');
  });

  it('includes extra context when provided', () => {
    const prompt = service.generate(
      makeContext({ extraContext: 'Performance-sensitive module' }),
      'span-ext',
    );

    expect(prompt.userPrompt).toContain('Performance-sensitive module');
  });

  it('output schema has required fields', () => {
    const prompt = service.generate(makeContext(), 'span-schema');

    expect(prompt.outputSchema.required).toContain('testCases');
    expect(prompt.outputSchema.required).toContain('summary');
    expect(prompt.outputSchema.required).toContain('riskLevel');
    expect(prompt.outputSchema.required).toContain('traceSpanId');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 测试规则管理
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('has 6 default test rules', () => {
    const rules = service.getAllRules();
    expect(rules).toHaveLength(6);
    expect(rules[0].ruleId).toBe('R-TEST-001');
  });

  it('addRule appends custom rule', () => {
    const customRule: TestRule = {
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
      testCases: [
        {
          name: 'Test login flow',
          category: 'regression',
          description: 'Verify login with valid credentials',
          expectedResult: 'User authenticated successfully',
        },
      ],
      summary: 'Found 1 critical test case',
      riskLevel: 'G3',
      traceSpanId: 'span-valid',
    };

    const issues = service.validateOutput(validOutput);
    expect(issues).toEqual([]);
  });

  it('detects missing required fields', () => {
    const incompleteOutput = {
      testCases: [],
      summary: 'test',
      // 缺少 riskLevel 和 traceSpanId
    };

    const issues = service.validateOutput(incompleteOutput);
    expect(issues).toContain('Missing required field: riskLevel');
    expect(issues).toContain('Missing required field: traceSpanId');
  });

  it('detects invalid riskLevel', () => {
    const output = {
      testCases: [],
      summary: 'test',
      riskLevel: 'G5',
      traceSpanId: 'span-x',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('Invalid riskLevel'))).toBe(true);
  });

  it('detects testCase with missing required fields', () => {
    const output = {
      testCases: [{ name: 'x' }], // 缺少 category, description, expectedResult
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'span-y',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('TestCase[0] missing'))).toBe(true);
  });

  it('detects invalid test case category', () => {
    const output = {
      testCases: [
        {
          name: 'x',
          category: 'invalid-cat',
          description: 'desc',
          expectedResult: 'result',
        },
      ],
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'span-z',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('invalid category'))).toBe(true);
  });

  it('detects short traceSpanId', () => {
    const output = {
      testCases: [],
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'ab', // 太短
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('traceSpanId too short'))).toBe(true);
  });

  it('allows valid traceSpanId with sufficient length', () => {
    const output = {
      testCases: [],
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

function makeContext(overrides: Partial<TesterPromptContext> = {}): TesterPromptContext {
  return {
    prTitle: 'Test PR',
    prDescription: 'Test description',
    changedFiles: ['src/test.ts'],
    riskLevel: 'G2',
    ...overrides,
  };
}
