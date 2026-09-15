/**
 * E6-2: SecurityPromptService —— Security-Agent 提示模板与安全规则集注入
 *
 * 职责：
 * - 提供 Security-Agent 的系统提示模板
 * - 注入深度安全规则集（针对 Reviewer-Agent 已标记的疑似项进行确认）
 * - 约束输出结构（JSON schema）
 * - 支持委托链标记（M3 delegation）
 *
 * 对应设计文档：
 * - detailed-design §4.6.3 M2 事件通知：Security-Agent 提前启动接收 SecurityAlertRequested
 * - detailed-design §4.6.4 M3 定向委托：Security-Agent 在限定 scope 内分析
 * - DES-13.9 安全底线：Security-Agent 不得绕过 PolicyEngine 直接调用工具
 */
import { Injectable, Logger } from '@nestjs/common';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 规则集
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SecurityDeepRule {
  ruleId: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  check: string; // 规则检查逻辑描述
  mitreTactic?: string; // MITRE ATT&CK 战术分类
}

export interface SecurityOutputSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 提示模板
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SecurityPromptContext {
  /** PR 标题 */
  prTitle: string;
  /** PR 描述 */
  prDescription: string;
  /** 变更文件列表 */
  changedFiles: string[];
  /** 风险级别 */
  riskLevel: string;
  /** Reviewer-Agent 已有的疑似发现（委托场景） */
  priorFindings?: string;
  /** 委托链标记（M3 定向委托） */
  delegatedBy?: string;
  /** scope 限定（M3 定向委托） */
  scope?: string;
  /** 额外上下文 */
  extraContext?: string;
}

export interface SecurityPrompt {
  systemPrompt: string;
  userPrompt: string;
  outputSchema: SecurityOutputSchema;
  traceSpanId: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 默认深度安全规则集（针对疑似项确认）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULT_SECURITY_DEEP_RULES: SecurityDeepRule[] = [
  {
    ruleId: 'R-SEC-DEEP-001',
    description: '硬编码凭证深度确认',
    severity: 'critical',
    check: '深度扫描代码中的 API key、secret、password、token，确认是否为真实凭证而非占位符',
    mitreTactic: 'Credential Access',
  },
  {
    ruleId: 'R-SEC-DEEP-002',
    description: '反序列化漏洞确认',
    severity: 'critical',
    check: '检查是否存在任意对象反序列化、YAML 解析器漏洞、XML External Entity (XXE)',
    mitreTactic: 'Execution',
  },
  {
    ruleId: 'R-SEC-DEEP-003',
    description: 'SQL 注入确认',
    severity: 'high',
    check: '检查动态 SQL 构建、ORM 配置缺陷、参数化查询缺失',
    mitreTactic: 'Injection',
  },
  {
    ruleId: 'R-SEC-DEEP-004',
    description: '服务器端请求伪造 (SSRF)',
    severity: 'high',
    check: '检查是否存在用户可控的 URL 请求、内网端口探测路径',
    mitreTactic: 'Discovery',
  },
  {
    ruleId: 'R-SEC-DEEP-005',
    description: '越权访问确认',
    severity: 'critical',
    check: '检查水平/垂直越权路径、JWT 签名验证缺陷、RBAC 策略绕过',
    mitreTactic: 'Privilege Escalation',
  },
  {
    ruleId: 'R-SEC-DEEP-006',
    description: '敏感数据泄露确认',
    severity: 'high',
    check: '检查日志、错误信息、API 响应中是否包含 PII/PCI 数据',
    mitreTactic: 'Collection',
  },
  {
    ruleId: 'R-SEC-DEEP-007',
    description: '依赖漏洞确认',
    severity: 'medium',
    check: '检查 package.json 中依赖版本是否存在已知 CVE',
    mitreTactic: 'Supply Chain',
  },
  {
    ruleId: 'R-SEC-DEEP-008',
    description: '加密算法强度确认',
    severity: 'high',
    check: '检查是否存在弱加密算法（MD5、DES）、硬编码密钥、不安全的随机数生成',
    mitreTactic: 'Defense Evasion',
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 输出 JSON Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SECURITY_OUTPUT_SCHEMA: SecurityOutputSchema = {
  type: 'object',
  properties: {
    confirmations: {
      type: 'array',
      description: '对疑似项的确认结果列表',
    },
    eachConfirmation: {
      type: 'object',
      properties: {
        findingId: { type: 'string', description: '关联的发现 ID（来自 Reviewer-Agent）' },
        confirmed: { type: 'boolean', description: '是否确认为真实安全问题' },
        severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: '确认后的严重级别' },
        ruleId: { type: 'string', description: '匹配的安全规则 ID' },
        description: { type: 'string', description: '确认结果描述' },
        evidence: { type: 'string', description: '证据指针（代码片段/调用栈）' },
        mitreTactic: { type: 'string', description: 'MITRE ATT&CK 战术分类' },
        remediation: { type: 'string', description: '修复建议' },
      },
      required: ['confirmed', 'severity', 'description'],
    },
    newFindings: {
      type: 'array',
      description: 'Security-Agent 独立发现的新安全问题',
    },
    overallRisk: {
      type: 'string',
      enum: ['G1', 'G2', 'G3', 'G4'],
      description: '综合风险评级',
    },
    summary: {
      type: 'string',
      description: '安全分析摘要（≤500 字）',
    },
    traceSpanId: {
      type: 'string',
      description: '追踪 span ID（用于审计归因）',
    },
  },
  required: ['confirmations', 'overallRisk', 'summary', 'traceSpanId'],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class SecurityPromptService {
  private readonly logger = new Logger(SecurityPromptService.name);
  private readonly customRules: SecurityDeepRule[] = [];

  /**
   * 生成 Security-Agent 提示（系统提示 + 用户提示）。
   * 注入深度安全规则集和输出结构约束。
   * 支持委托链标记（M3）和 prior findings 确认（M2）。
   */
  generate(context: SecurityPromptContext, traceSpanId: string): SecurityPrompt {
    const rulesSummary = this.buildRulesSummary();
    const systemPrompt = this.buildSystemPrompt(rulesSummary, context);
    const userPrompt = this.buildUserPrompt(context);

    this.logger.debug(
      `Generated Security prompt for pr=${context.prTitle} traceSpanId=${traceSpanId} delegatedBy=${context.delegatedBy ?? 'none'}`,
    );

    return {
      systemPrompt,
      userPrompt,
      outputSchema: SECURITY_OUTPUT_SCHEMA,
      traceSpanId,
    };
  }

  /**
   * 添加自定义深度安全规则。
   */
  addRule(rule: SecurityDeepRule): void {
    this.customRules.push(rule);
    this.logger.log(`Added custom security deep rule: ${rule.ruleId}`);
  }

  /**
   * 移除自定义深度安全规则。
   */
  removeRule(ruleId: string): boolean {
    const idx = this.customRules.findIndex((r) => r.ruleId === ruleId);
    if (idx >= 0) {
      this.customRules.splice(idx, 1);
      this.logger.log(`Removed custom security deep rule: ${ruleId}`);
      return true;
    }
    return false;
  }

  /**
   * 获取所有深度安全规则（默认 + 自定义）。
   */
  getAllRules(): SecurityDeepRule[] {
    return [...DEFAULT_SECURITY_DEEP_RULES, ...this.customRules];
  }

  /**
   * 验证输出是否符合 schema。
   */
  validateOutput(output: Record<string, unknown>): string[] {
    const issues: string[] = [];

    // 必填字段检查
    const requiredFields = ['confirmations', 'overallRisk', 'summary', 'traceSpanId'];
    for (const field of requiredFields) {
      if (!(field in output)) {
        issues.push(`Missing required field: ${field}`);
      }
    }

    // overallRisk 枚举检查
    const overallRisk = output['overallRisk'] as string;
    if (overallRisk && !['G1', 'G2', 'G3', 'G4'].includes(overallRisk)) {
      issues.push(`Invalid overallRisk: ${overallRisk} (expected G1/G2/G3/G4)`);
    }

    // traceSpanId 格式检查
    const traceSpanId = output['traceSpanId'] as string;
    if (traceSpanId && traceSpanId.length < 5) {
      issues.push('traceSpanId too short');
    }

    // confirmations 结构检查
    const confirmations = output['confirmations'] as Array<Record<string, unknown>>;
    if (Array.isArray(confirmations)) {
      for (let i = 0; i < confirmations.length; i++) {
        const confirmation = confirmations[i];
        if (confirmation['confirmed'] === undefined) {
          issues.push(`Confirmation[${i}] missing required field: confirmed`);
        }
        const severity = confirmation['severity'] as string;
        if (severity && !['critical', 'high', 'medium', 'low'].includes(severity)) {
          issues.push(`Confirmation[${i}] invalid severity: ${severity}`);
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
      .map((r) => `[${r.severity.toUpperCase()}] ${r.ruleId}: ${r.description} — ${r.check}${r.mitreTactic ? ` (MITRE: ${r.mitreTactic})` : ''}`)
      .join('\n');
  }

  private buildSystemPrompt(rulesSummary: string, context: SecurityPromptContext): string {
    const delegationNote = context.delegatedBy
      ? `\n## 委托链信息（M3）
- 委托方: ${context.delegatedBy}
- 限定范围: ${context.scope ?? '未指定'}
请在限定范围内进行深度安全分析。`
      : '';

    const priorFindingsNote = context.priorFindings
      ? `\n## Reviewer-Agent 疑似发现（M2）
${context.priorFindings}
请对上述疑似项进行深度确认，区分真实漏洞与误报。`
      : '';

    return `你是一名专业的安全工程师（Security-Agent）。你的职责是对代码变更进行深度安全分析，确认疑似安全问题，并发现新的安全漏洞。

## 安全深度规则集（必须遵守）
${rulesSummary}

## 输出要求
- 必须以 JSON 格式输出
- 必须包含 confirmations、overallRisk、summary、traceSpanId 字段
- overallRisk 必须是 G1/G2/G3/G4 之一
- traceSpanId 用于审计归因，必须有效
- summary 不超过 500 字

## 约束
- 不得绕过 PolicyEngine 直接调用工具
- 所有工具调用必须经过内核拦截后走 Policy 裁决
- 确认 critical 级别安全问题时，必须标记为 blocked${delegationNote}${priorFindingsNote}`;
  }

  private buildUserPrompt(context: SecurityPromptContext): string {
    const filesList = context.changedFiles.map((f) => `- ${f}`).join('\n');
    let prompt = `请对以下 PR 进行深度安全分析：

**标题**: ${context.prTitle}
**描述**: ${context.prDescription}
**风险级别**: ${context.riskLevel}
**变更文件** (${context.changedFiles.length} 个):
${filesList}`;

    if (context.delegatedBy) {
      prompt += `\n\n**委托来源**: ${context.delegatedBy}`;
      if (context.scope) {
        prompt += `\n**分析范围**: ${context.scope}`;
      }
    }

    if (context.extraContext) {
      prompt += `\n\n**额外上下文**: ${context.extraContext}`;
    }

    prompt += '\n\n请以 JSON 格式输出安全分析结果。';
    return prompt;
  }
}
