/**
 * E5-1: ReviewerPromptService —— Reviewer-Agent 提示模板与规则集注入
 *
 * 职责：
 * - 提供 Reviewer-Agent 的系统提示模板
 * - 注入安全规则集（DES-13.9 安全底线）
 * - 约束输出结构（JSON schema）
 * - 支持自定义规则追加
 *
 * 对应设计文档：
 * - DES-13.9 安全底线：Reviewer-Agent 不得绕过 PolicyEngine 直接调用工具
 * - detailed-design §4.5.3 上下文预算管控
 */
import { Injectable, Logger } from '@nestjs/common';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 规则集
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SecurityRule {
  ruleId: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  check: string; // 规则检查逻辑描述
}

export interface ReviewerOutputSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 提示模板
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ReviewerPromptContext {
  /** PR 标题 */
  prTitle: string;
  /** PR 描述 */
  prDescription: string;
  /** 变更文件列表 */
  changedFiles: string[];
  /** 风险级别 */
  riskLevel: string;
  /** 已有安全规则摘要 */
  existingFindings?: string;
  /** 额外上下文 */
  extraContext?: string;
}

export interface ReviewerPrompt {
  systemPrompt: string;
  userPrompt: string;
  outputSchema: ReviewerOutputSchema;
  traceSpanId: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 默认安全规则集（DES-13.9）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULT_SECURITY_RULES: SecurityRule[] = [
  {
    ruleId: 'R-SEC-001',
    description: '禁止硬编码凭证',
    severity: 'critical',
    check: '检查代码中是否存在 hardcoded password/token/API key',
  },
  {
    ruleId: 'R-SEC-002',
    description: '禁止不安全反序列化',
    severity: 'high',
    check: '检查是否存在 eval()/exec() 或不安全的 deserialize 调用',
  },
  {
    ruleId: 'R-SEC-003',
    description: 'SQL 注入防护',
    severity: 'high',
    check: '检查是否存在字符串拼接 SQL 查询',
  },
  {
    ruleId: 'R-SEC-004',
    description: 'XSS 防护',
    severity: 'medium',
    check: '检查是否存在未转义的 HTML 输出',
  },
  {
    ruleId: 'R-SEC-005',
    description: '权限提升检测',
    severity: 'critical',
    check: '检查是否存在 privilege escalation 路径',
  },
  {
    ruleId: 'R-SEC-006',
    description: '敏感数据泄露',
    severity: 'high',
    check: '检查日志/响应中是否包含敏感数据',
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 输出 JSON Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const REVIEWER_OUTPUT_SCHEMA: ReviewerOutputSchema = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      description: '代码审查发现列表',
    },
    eachFinding: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '问题文件' },
        line: { type: 'number', description: '问题行号' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: '严重级别' },
        ruleId: { type: 'string', description: '违反的规则 ID' },
        description: { type: 'string', description: '问题描述' },
        suggestion: { type: 'string', description: '修复建议' },
      },
      required: ['file', 'severity', 'ruleId', 'description'],
    },
    summary: {
      type: 'string',
      description: '审查摘要（≤500 字）',
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
  required: ['findings', 'summary', 'riskLevel', 'traceSpanId'],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class ReviewerPromptService {
  private readonly logger = new Logger(ReviewerPromptService.name);
  private readonly customRules: SecurityRule[] = [];

  /**
   * 生成 Reviewer-Agent 提示（系统提示 + 用户提示）。
   * 注入安全规则集和输出结构约束。
   */
  generate(context: ReviewerPromptContext, traceSpanId: string): ReviewerPrompt {
    const rulesSummary = this.buildRulesSummary();
    const systemPrompt = this.buildSystemPrompt(rulesSummary);
    const userPrompt = this.buildUserPrompt(context);

    this.logger.debug(`Generated Reviewer prompt for pr=${context.prTitle} traceSpanId=${traceSpanId}`);

    return {
      systemPrompt,
      userPrompt,
      outputSchema: REVIEWER_OUTPUT_SCHEMA,
      traceSpanId,
    };
  }

  /**
   * 添加自定义安全规则。
   */
  addRule(rule: SecurityRule): void {
    this.customRules.push(rule);
    this.logger.log(`Added custom security rule: ${rule.ruleId}`);
  }

  /**
   * 移除自定义安全规则。
   */
  removeRule(ruleId: string): boolean {
    const idx = this.customRules.findIndex((r) => r.ruleId === ruleId);
    if (idx >= 0) {
      this.customRules.splice(idx, 1);
      this.logger.log(`Removed custom security rule: ${ruleId}`);
      return true;
    }
    return false;
  }

  /**
   * 获取所有安全规则（默认 + 自定义）。
   */
  getAllRules(): SecurityRule[] {
    return [...DEFAULT_SECURITY_RULES, ...this.customRules];
  }

  /**
   * 验证输出是否符合 schema。
   */
  validateOutput(output: Record<string, unknown>): string[] {
    const issues: string[] = [];

    // 必填字段检查
    const requiredFields = ['findings', 'summary', 'riskLevel', 'traceSpanId'];
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

    // findings 结构检查
    const findings = output['findings'] as Array<Record<string, unknown>>;
    if (Array.isArray(findings)) {
      for (let i = 0; i < findings.length; i++) {
        const finding = findings[i];
        if (!finding['severity'] || !finding['ruleId'] || !finding['description']) {
          issues.push(`Finding[${i}] missing required fields (severity/ruleId/description)`);
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
    return `你是一名专业的代码安全审查员（Reviewer-Agent）。你的职责是审查代码变更，识别安全风险，并给出修复建议。

## 安全规则集（必须遵守）
${rulesSummary}

## 输出要求
- 必须以 JSON 格式输出
- 必须包含 findings、summary、riskLevel、traceSpanId 字段
- riskLevel 必须是 G1/G2/G3/G4 之一
- traceSpanId 用于审计归因，必须有效
- summary 不超过 500 字

## 约束
- 不得绕过 PolicyEngine 直接调用工具
- 所有工具调用必须经过内核拦截后走 Policy 裁决
- 发现 critical 级别问题时，必须标记为 blocked`;
  }

  private buildUserPrompt(context: ReviewerPromptContext): string {
    const filesList = context.changedFiles.map((f) => `- ${f}`).join('\n');
    let prompt = `请审查以下 PR：

**标题**: ${context.prTitle}
**描述**: ${context.prDescription}
**风险级别**: ${context.riskLevel}
**变更文件** (${context.changedFiles.length} 个):
${filesList}`;

    if (context.existingFindings) {
      prompt += `\n\n**已有发现**: ${context.existingFindings}`;
    }

    if (context.extraContext) {
      prompt += `\n\n**额外上下文**: ${context.extraContext}`;
    }

    prompt += '\n\n请以 JSON 格式输出审查结果。';
    return prompt;
  }
}
