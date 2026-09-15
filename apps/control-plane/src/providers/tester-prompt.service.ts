/**
 * E6-1: TesterPromptService —— Tester-Agent 提示模板与评测规则集注入
 *
 * 职责：
 * - 提供 Tester-Agent 的系统提示模板
 * - 注入评测规则集（测试覆盖率、边界条件、回归检测）
 * - 约束输出结构（JSON schema）
 * - 支持自定义测试规则追加
 *
 * 对应设计文档：
 * - detailed-design §4.3 协作模型：Tester-Agent 与 Reviewer/Security 并行阶段流水协作
 * - DES-13 安全底线：Tester-Agent 不得绕过 PolicyEngine 直接调用工具
 */
import { Injectable, Logger } from '@nestjs/common';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 规则集
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface TestRule {
  ruleId: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  check: string; // 规则检查逻辑描述
}

export interface TesterOutputSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 提示模板
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface TesterPromptContext {
  /** PR 标题 */
  prTitle: string;
  /** PR 描述 */
  prDescription: string;
  /** 变更文件列表 */
  changedFiles: string[];
  /** 风险级别 */
  riskLevel: string;
  /** 已有测试结果摘要 */
  existingTestResults?: string;
  /** 测试覆盖范围要求 */
  coverageRequirement?: string;
  /** 额外上下文 */
  extraContext?: string;
}

export interface TesterPrompt {
  systemPrompt: string;
  userPrompt: string;
  outputSchema: TesterOutputSchema;
  traceSpanId: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 默认测试规则集
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULT_TEST_RULES: TestRule[] = [
  {
    ruleId: 'R-TEST-001',
    description: '核心功能回归测试',
    severity: 'critical',
    check: '验证变更未破坏现有核心功能的正常路径',
  },
  {
    ruleId: 'R-TEST-002',
    description: '边界条件测试',
    severity: 'high',
    check: '检查边界值、空值、极端输入等异常路径',
  },
  {
    ruleId: 'R-TEST-003',
    description: '向后兼容性测试',
    severity: 'high',
    check: '验证 API 契约、数据结构未发生破坏性变更',
  },
  {
    ruleId: 'R-TEST-004',
    description: '性能回归检测',
    severity: 'medium',
    check: '检查是否存在明显的性能退化（如 O(n²) 替代 O(n)）',
  },
  {
    ruleId: 'R-TEST-005',
    description: '错误处理完整性',
    severity: 'high',
    check: '验证所有 public 方法均有适当的错误处理',
  },
  {
    ruleId: 'R-TEST-006',
    description: '并发安全测试',
    severity: 'critical',
    check: '检查变更是否引入竞态条件或死锁风险',
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 输出 JSON Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TESTER_OUTPUT_SCHEMA: TesterOutputSchema = {
  type: 'object',
  properties: {
    testCases: {
      type: 'array',
      description: '建议测试用例列表',
    },
    eachTestCase: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '测试用例名称' },
        category: { type: 'string', enum: ['regression', 'boundary', 'compatibility', 'performance', 'error-handling', 'concurrency'], description: '测试类别' },
        priority: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: '优先级' },
        description: { type: 'string', description: '测试描述' },
        expectedResult: { type: 'string', description: '预期结果' },
      },
      required: ['name', 'category', 'description', 'expectedResult'],
    },
    coverageGap: {
      type: 'array',
      description: '测试覆盖缺口',
    },
    summary: {
      type: 'string',
      description: '测试评估摘要（≤500 字）',
    },
    riskLevel: {
      type: 'string',
      enum: ['G1', 'G2', 'G3', 'G4'],
      description: '综合风险评级',
    },
    traceSpanId: {
      type: 'string',
      description: '追踪 span ID（用于审计归因）',
    },
  },
  required: ['testCases', 'summary', 'riskLevel', 'traceSpanId'],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class TesterPromptService {
  private readonly logger = new Logger(TesterPromptService.name);
  private readonly customRules: TestRule[] = [];

  /**
   * 生成 Tester-Agent 提示（系统提示 + 用户提示）。
   * 注入测试规则集和输出结构约束。
   */
  generate(context: TesterPromptContext, traceSpanId: string): TesterPrompt {
    const rulesSummary = this.buildRulesSummary();
    const systemPrompt = this.buildSystemPrompt(rulesSummary);
    const userPrompt = this.buildUserPrompt(context);

    this.logger.debug(`Generated Tester prompt for pr=${context.prTitle} traceSpanId=${traceSpanId}`);

    return {
      systemPrompt,
      userPrompt,
      outputSchema: TESTER_OUTPUT_SCHEMA,
      traceSpanId,
    };
  }

  /**
   * 添加自定义测试规则。
   */
  addRule(rule: TestRule): void {
    this.customRules.push(rule);
    this.logger.log(`Added custom test rule: ${rule.ruleId}`);
  }

  /**
   * 移除自定义测试规则。
   */
  removeRule(ruleId: string): boolean {
    const idx = this.customRules.findIndex((r) => r.ruleId === ruleId);
    if (idx >= 0) {
      this.customRules.splice(idx, 1);
      this.logger.log(`Removed custom test rule: ${ruleId}`);
      return true;
    }
    return false;
  }

  /**
   * 获取所有测试规则（默认 + 自定义）。
   */
  getAllRules(): TestRule[] {
    return [...DEFAULT_TEST_RULES, ...this.customRules];
  }

  /**
   * 验证输出是否符合 schema。
   */
  validateOutput(output: Record<string, unknown>): string[] {
    const issues: string[] = [];

    // 必填字段检查
    const requiredFields = ['testCases', 'summary', 'riskLevel', 'traceSpanId'];
    for (const field of requiredFields) {
      if (!(field in output)) {
        issues.push(`Missing required field: ${field}`);
      }
    }

    // riskLevel 枚举检查
    const riskLevel = output['riskLevel'] as string;
    if (riskLevel && !['G1', 'G2', 'G3', 'G4'].includes(riskLevel)) {
      issues.push(`Invalid riskLevel: ${riskLevel} (expected G1/G2/G3/G4)`);
    }

    // traceSpanId 格式检查
    const traceSpanId = output['traceSpanId'] as string;
    if (traceSpanId && traceSpanId.length < 5) {
      issues.push('traceSpanId too short');
    }

    // testCases 结构检查
    const testCases = output['testCases'] as Array<Record<string, unknown>>;
    if (Array.isArray(testCases)) {
      for (let i = 0; i < testCases.length; i++) {
        const testCase = testCases[i];
        if (!testCase['name'] || !testCase['category'] || !testCase['description'] || !testCase['expectedResult']) {
          issues.push(`TestCase[${i}] missing required fields (name/category/description/expectedResult)`);
        }
        const category = testCase['category'] as string;
        if (category && !['regression', 'boundary', 'compatibility', 'performance', 'error-handling', 'concurrency'].includes(category)) {
          issues.push(`TestCase[${i}] invalid category: ${category}`);
        }
      }
    }

    return issues;
  }

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 私有
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  private buildRulesSummary(): string {
    const allRules = this.getAllRules();
    return allRules
      .map((r) => `[${r.severity.toUpperCase()}] ${r.ruleId}: ${r.description} — ${r.check}`)
      .join('\n');
  }

  private buildSystemPrompt(rulesSummary: string): string {
    return `你是一名专业的软件测试工程师（Tester-Agent）。你的职责是评估代码变更的测试覆盖度，识别测试缺口，并生成测试用例建议。

## 测试规则集（必须遵守）
${rulesSummary}

## 输出要求
- 必须以 JSON 格式输出
- 必须包含 testCases、summary、riskLevel、traceSpanId 字段
- riskLevel 必须是 G1/G2/G3/G4 之一
- traceSpanId 用于审计归因，必须有效
- summary 不超过 500 字

## 约束
- 不得绕过 PolicyEngine 直接调用工具
- 所有工具调用必须经过内核拦截后走 Policy 裁决
- 发现 critical 级别问题时，必须标记为 blocked`;
  }

  private buildUserPrompt(context: TesterPromptContext): string {
    const filesList = context.changedFiles.map((f) => `- ${f}`).join('\n');
    let prompt = `请评估以下 PR 的测试覆盖度：

**标题**: ${context.prTitle}
**描述**: ${context.prDescription}
**风险级别**: ${context.riskLevel}
**变更文件** (${context.changedFiles.length} 个):
${filesList}`;

    if (context.existingTestResults) {
      prompt += `\n\n**已有测试结果**: ${context.existingTestResults}`;
    }

    if (context.coverageRequirement) {
      prompt += `\n\n**覆盖要求**: ${context.coverageRequirement}`;
    }

    if (context.extraContext) {
      prompt += `\n\n**额外上下文**: ${context.extraContext}`;
    }

    prompt += '\n\n请以 JSON 格式输出测试评估结果。';
    return prompt;
  }
}
