/**
 * E6-2: SecurityPromptService 单元测试
 *
 * 覆盖：
 * - 提示生成（系统提示 + 用户提示）
 * - 深度安全规则集注入
 * - 委托链标记（M3）和 prior findings 确认（M2）
 * - 自定义规则增删
 * - 输出验证（schema 合规性）
 * - traceSpanId 传播
 */
import { Test } from '@nestjs/testing';
import { SecurityPromptService } from './security-prompt.service';

describe('E6-2 SecurityPromptService', () => {
  let service: SecurityPromptService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [SecurityPromptService],
    }).compile();
    service = moduleRef.get<SecurityPromptService>(SecurityPromptService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 提示生成
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('generates system prompt with deep security rules', () => {
    const prompt = service.generate(makeContext(), 'span-123');

    expect(prompt.systemPrompt).toContain('Security-Agent');
    expect(prompt.systemPrompt).toContain('R-SEC-DEEP-001');
    expect(prompt.systemPrompt).toContain('硬编码凭证深度确认');
    expect(prompt.traceSpanId).toBe('span-123');
  });

  it('generates user prompt with PR context', () => {
    const context = makeContext({
      prTitle: 'Fix auth vulnerability',
      changedFiles: ['src/auth.ts', 'src/middleware.ts'],
    });
    const prompt = service.generate(context, 'span-456');

    expect(prompt.userPrompt).toContain('Fix auth vulnerability');
    expect(prompt.userPrompt).toContain('src/auth.ts');
    expect(prompt.userPrompt).toContain('src/middleware.ts');
  });

  it('includes prior findings from Reviewer-Agent in system prompt', () => {
    const prompt = service.generate(
      makeContext({
        priorFindings: '疑似存在硬编码密钥 in src/auth.ts:45',
      }),
      'span-m2',
    );

    expect(prompt.systemPrompt).toContain('疑似存在硬编码密钥 in src/auth.ts:45');
  });

  it('includes delegation info when delegatedBy is set', () => {
    const prompt = service.generate(
      makeContext({
        delegatedBy: 'reviewer-bot',
        scope: '鉴权模块',
      }),
      'span-m3',
    );

    expect(prompt.systemPrompt).toContain('reviewer-bot');
    expect(prompt.systemPrompt).toContain('鉴权模块');
  });

  it('includes extra context when provided', () => {
    const prompt = service.generate(
      makeContext({ extraContext: 'Customer PII involved' }),
      'span-ext',
    );

    expect(prompt.userPrompt).toContain('Customer PII involved');
  });

  it('output schema has required fields', () => {
    const prompt = service.generate(makeContext(), 'span-schema');

    expect(prompt.outputSchema.required).toContain('confirmations');
    expect(prompt.outputSchema.required).toContain('overallRisk');
    expect(prompt.outputSchema.required).toContain('summary');
    expect(prompt.outputSchema.required).toContain('traceSpanId');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 深度安全规则管理
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('has 8 default security deep rules', () => {
    const rules = service.getAllRules();
    expect(rules).toHaveLength(8);
    expect(rules[0].ruleId).toBe('R-SEC-DEEP-001');
  });

  it('default rules include mitreTactic', () => {
    const rules = service.getAllRules();
    const firstRule = rules[0];
    expect(firstRule.mitreTactic).toBe('Credential Access');
  });

  it('addRule appends custom rule', () => {
    const customRule: SecurityDeepRule = {
      ruleId: 'R-CUSTOM-001',
      description: 'Custom rule',
      severity: 'low',
      check: 'Custom check',
    };

    service.addRule(customRule);
    const rules = service.getAllRules();
    expect(rules).toHaveLength(9);
    expect(rules[8].ruleId).toBe('R-CUSTOM-001');
  });

  it('removeRule removes custom rule', () => {
    service.addRule({ ruleId: 'R-TEMP', description: 'temp', severity: 'low', check: 't' });
    expect(service.getAllRules()).toHaveLength(9);

    service.removeRule('R-TEMP');
    expect(service.getAllRules()).toHaveLength(8);
  });

  it('removeRule returns false for non-existent rule', () => {
    expect(service.removeRule('R-NONEXIST')).toBe(false);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 输出验证
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('validates correct output structure', () => {
    const validOutput = {
      confirmations: [
        {
          findingId: 'finding-001',
          confirmed: true,
          severity: 'critical',
          description: 'Hardcoded API key confirmed',
          evidence: 'src/auth.ts:45',
          mitreTactic: 'Credential Access',
          remediation: 'Move to environment variable',
        },
      ],
      overallRisk: 'G3',
      summary: 'Found 1 confirmed vulnerability',
      traceSpanId: 'span-valid',
    };

    const issues = service.validateOutput(validOutput);
    expect(issues).toEqual([]);
  });

  it('detects missing required fields', () => {
    const incompleteOutput = {
      confirmations: [],
      summary: 'test',
      // 缺少 overallRisk 和 traceSpanId
    };

    const issues = service.validateOutput(incompleteOutput);
    expect(issues).toContain('Missing required field: overallRisk');
    expect(issues).toContain('Missing required field: traceSpanId');
  });

  it('detects invalid overallRisk', () => {
    const output = {
      confirmations: [],
      overallRisk: 'G5',
      summary: 'test',
      traceSpanId: 'span-x',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('Invalid overallRisk'))).toBe(true);
  });

  it('detects confirmation with missing required fields', () => {
    const output = {
      confirmations: [{}], // 缺少 confirmed, severity, description
      overallRisk: 'G2',
      summary: 'test',
      traceSpanId: 'span-y',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('Confirmation[0] missing'))).toBe(true);
  });

  it('detects invalid confirmation severity', () => {
    const output = {
      confirmations: [
        {
          confirmed: true,
          severity: 'extreme',
          description: 'desc',
        },
      ],
      overallRisk: 'G2',
      summary: 'test',
      traceSpanId: 'span-z',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('invalid severity'))).toBe(true);
  });

  it('detects short traceSpanId', () => {
    const output = {
      confirmations: [],
      overallRisk: 'G2',
      summary: 'test',
      traceSpanId: 'ab', // 太短
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('traceSpanId too short'))).toBe(true);
  });

  it('allows valid traceSpanId with sufficient length', () => {
    const output = {
      confirmations: [],
      overallRisk: 'G2',
      summary: 'test',
      traceSpanId: 'span-abc-123',
    };

    const issues = service.validateOutput(output);
    expect(issues).toEqual([]);
  });

  it('validates output with empty confirmations array', () => {
    const output = {
      confirmations: [],
      overallRisk: 'G1',
      summary: 'No vulnerabilities found',
      traceSpanId: 'span-clean',
    };

    const issues = service.validateOutput(output);
    expect(issues).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 辅助函数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function makeContext(overrides: Partial<SecurityPromptContext> = {}): SecurityPromptContext {
  return {
    prTitle: 'Test PR',
    prDescription: 'Test description',
    changedFiles: ['src/test.ts'],
    riskLevel: 'G2',
    ...overrides,
  };
}
