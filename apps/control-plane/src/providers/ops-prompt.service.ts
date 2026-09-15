/**
 * E7-1: OpsPromptService —— Ops-Agent 提示模板与发布规则集注入
 *
 * 职责：
 * - 提供 Ops-Agent 的系统提示模板
 * - 注入发布规则集（变更 Diff / 回滚预案 / deploy-token 生命周期）
 * - 约束输出结构（JSON schema）
 * - 支持审批场景上下文（UC-03 高危发布审批）
 *
 * 对应设计文档：
 * - detailed-design §4.6.5 UC-03 发布审批：Ops-Agent 准备发布清单 → 申请 prod.deploy → 等待 HITL 授权 → 以 token 触发发布
 * - DES-13.9 安全底线：Ops-Agent 不得绕过 PolicyEngine 直接调用部署工具
 * - FR-M3-05：G4 高危动作需双人审批（Release Manager + Security Officer）
 */
import { Injectable, Logger } from '@nestjs/common';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 规则集
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface OpsRule {
  ruleId: string;
  description: string;
  severity: 'critical' | 'high' | 'medium' | 'low';
  check: string; // 规则检查逻辑描述
  mitreTactic?: string; // MITRE ATT&CK 战术分类（适用时）
}

export interface OpsOutputSchema {
  type: 'object';
  properties: Record<string, { type: string; description: string }>;
  required: string[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 提示模板
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface OpsPromptContext {
  /** PR 标题 */
  prTitle: string;
  /** PR 描述 */
  prDescription: string;
  /** 变更文件列表 */
  changedFiles: string[];
  /** 风险级别 */
  riskLevel: string;
  /** 目标环境（staging | production） */
  targetEnvironment: string;
  /** 变更 Diff 摘要 */
  diffSummary?: string;
  /** 已有回滚预案 */
  rollbackPlan?: string;
  /** 金丝雀指标（如有） */
  canaryMetrics?: string;
  /** 部署目标（ArgoCD app name / K8s namespace） */
  deployTarget?: string;
  /** Token TTL（秒） */
  tokenTtlSeconds?: number;
  /** 额外上下文 */
  extraContext?: string;
}

export interface OpsPrompt {
  systemPrompt: string;
  userPrompt: string;
  outputSchema: OpsOutputSchema;
  traceSpanId: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 默认发布规则集
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const DEFAULT_OPS_RULES: OpsRule[] = [
  {
    ruleId: 'R-OPS-001',
    description: '变更 Diff 完整性',
    severity: 'critical',
    check: '确保变更 Diff 包含所有受影响文件和代码路径，不得遗漏关键变更点',
  },
  {
    ruleId: 'R-OPS-002',
    description: '回滚预案必备',
    severity: 'critical',
    check: '每个发布计划必须包含可执行回滚预案（含回滚步骤、验证标准和时间上限）',
    mitreTactic: 'Defense Evasion',
  },
  {
    ruleId: 'R-OPS-003',
    description: '金丝雀发布前置条件',
    severity: 'high',
    check: '生产发布前必须完成金丝雀阶段，且金丝雀指标（错误率/延迟/资源使用）均在阈值内',
    mitreTactic: 'Discovery',
  },
  {
    ruleId: 'R-OPS-004',
    description: 'deploy-token scope 最小化',
    severity: 'high',
    check: 'deploy-token 的 scope 必须严格限定到目标应用和环境，不得泛化（prod-scoped TTL ≤ 15min）',
    mitreTactic: 'Privilege Escalation',
  },
  {
    ruleId: 'R-OPS-005',
    description: 'Token TTL 自动过期',
    severity: 'high',
    check: 'deploy-token TTL 到期后必须立即失效，不得延长；过期未用的 token 需重新申请',
    mitreTactic: 'Credential Access',
  },
  {
    ruleId: 'R-OPS-006',
    description: '审批 quorum 校验',
    severity: 'critical',
    check: 'G4 高危发布必须通过双人审批（Release Manager + Security Officer），quorum 未达成则禁止触发部署',
    mitreTactic: 'Privilege Escalation',
  },
  {
    ruleId: 'R-OPS-007',
    description: '审计日志固化',
    severity: 'high',
    check: '发布全流程事件必须写入 NATS → Audit 域 WORM 存储（含审批人、理由、token JTI、决策时间戳）',
    mitreTactic: 'Defense Evasion',
  },
  {
    ruleId: 'R-OPS-008',
    description: '紧急熔断能力',
    severity: 'critical',
    check: '发现异常时必须支持 emergencyFreeze（按 principal 吊销所有 token 并广播熔断事件）',
    mitreTactic: 'Impact',
  },
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 输出 JSON Schema
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const OPS_OUTPUT_SCHEMA: OpsOutputSchema = {
  type: 'object',
  properties: {
    changeDiff: {
      type: 'object',
      description: '变更 Diff 结构化摘要',
    },
    eachChangedFile: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '变更文件路径' },
        impact: { type: 'string', enum: ['critical', 'high', 'medium', 'low'], description: '变更影响级别' },
        summary: { type: 'string', description: '变更内容摘要' },
        riskFactor: { type: 'string', description: '风险因子说明' },
      },
      required: ['path', 'impact', 'summary'],
    },
    rollbackPlan: {
      type: 'object',
      description: '回滚预案',
    },
    eachRollbackStep: {
      type: 'object',
      properties: {
        step: { type: 'number', description: '步骤序号' },
        action: { type: 'string', description: '回滚动作' },
        validation: { type: 'string', description: '验证标准' },
        maxDuration: { type: 'string', description: '最大执行时间' },
      },
      required: ['step', 'action', 'validation'],
    },
    deployTokenRequest: {
      type: 'object',
      description: 'deploy-token 申请信息',
    },
    tokenScope: {
      type: 'string',
      description: 'token 作用范围（如 prod-scoped）',
    },
    tokenTtlSeconds: {
      type: 'number',
      description: 'token TTL（秒，≤900）',
    },
    targetEnvironment: {
      type: 'string',
      description: '目标环境',
    },
    approvalRequired: {
      type: 'boolean',
      description: '是否需要审批（G3/G4 为 true）',
    },
    approvalQuorum: {
      type: 'object',
      description: '审批 quorum 要求',
    },
    requiredApprovers: {
      type: 'array',
      items: { type: 'string' },
      description: '所需审批角色列表',
    },
    risks: {
      type: 'array',
      description: '发布风险项列表',
    },
    summary: {
      type: 'string',
      description: '发布准备摘要（≤500 字）',
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
  required: ['changeDiff', 'rollbackPlan', 'deployTokenRequest', 'summary', 'riskLevel', 'traceSpanId'],
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class OpsPromptService {
  private readonly logger = new Logger(OpsPromptService.name);
  private readonly customRules: OpsRule[] = [];

  /**
   * 生成 Ops-Agent 提示（系统提示 + 用户提示）。
   * 注入发布规则集和输出结构约束。
   * 支持 UC-03 高危发布审批场景。
   */
  generate(context: OpsPromptContext, traceSpanId: string): OpsPrompt {
    const rulesSummary = this.buildRulesSummary();
    const systemPrompt = this.buildSystemPrompt(rulesSummary, context);
    const userPrompt = this.buildUserPrompt(context);

    this.logger.debug(
      `Generated Ops prompt for pr=${context.prTitle} env=${context.targetEnvironment} traceSpanId=${traceSpanId}`,
    );

    return {
      systemPrompt,
      userPrompt,
      outputSchema: OPS_OUTPUT_SCHEMA,
      traceSpanId,
    };
  }

  /**
   * 添加自定义发布规则。
   */
  addRule(rule: OpsRule): void {
    this.customRules.push(rule);
    this.logger.log(`Added custom ops rule: ${rule.ruleId}`);
  }

  /**
   * 移除自定义发布规则。
   */
  removeRule(ruleId: string): boolean {
    const idx = this.customRules.findIndex((r) => r.ruleId === ruleId);
    if (idx >= 0) {
      this.customRules.splice(idx, 1);
      this.logger.log(`Removed custom ops rule: ${ruleId}`);
      return true;
    }
    return false;
  }

  /**
   * 获取所有发布规则（默认 + 自定义）。
   */
  getAllRules(): OpsRule[] {
    return [...DEFAULT_OPS_RULES, ...this.customRules];
  }

  /**
   * 验证输出是否符合 schema。
   */
  validateOutput(output: Record<string, unknown>): string[] {
    const issues: string[] = [];

    // 必填字段检查
    const requiredFields = ['changeDiff', 'rollbackPlan', 'deployTokenRequest', 'summary', 'riskLevel', 'traceSpanId'];
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

    // deployTokenRequest 检查
    const deployTokenRequest = output['deployTokenRequest'] as Record<string, unknown>;
    if (deployTokenRequest) {
      if (deployTokenRequest['tokenScope'] === undefined && deployTokenRequest['targetEnvironment'] === undefined) {
        issues.push('deployTokenRequest missing tokenScope or targetEnvironment');
      }
      const ttl = deployTokenRequest['tokenTtlSeconds'] as number;
      if (typeof ttl === 'number' && ttl > 900) {
        issues.push('tokenTtlSeconds must be ≤ 900 (15min max)');
      }
    }

    // rollbackPlan 检查
    const rollbackPlan = output['rollbackPlan'] as Record<string, unknown>;
    if (rollbackPlan) {
      const steps = rollbackPlan['steps'] as Array<Record<string, unknown>>;
      if (Array.isArray(steps) && steps.length > 0) {
        for (let i = 0; i < steps.length; i++) {
          const step = steps[i];
          if (!step['action'] || !step['validation']) {
            issues.push(`RollbackStep[${i}] missing required fields (action/validation)`);
          }
        }
      }
    }

    // changeDiff 检查
    const changeDiff = output['changeDiff'] as Record<string, unknown>;
    if (changeDiff) {
      const files = changeDiff['files'] as Array<Record<string, unknown>>;
      if (Array.isArray(files) && files.length > 0) {
        for (let i = 0; i < files.length; i++) {
          const file = files[i];
          if (!file['path'] || !file['impact'] || !file['summary']) {
            issues.push(`ChangedFile[${i}] missing required fields (path/impact/summary)`);
          }
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
      .map((r) =>
        `[${r.severity.toUpperCase()}] ${r.ruleId}: ${r.description} — ${r.check}${r.mitreTactic ? ` (MITRE: ${r.mitreTactic})` : ''}`,
      )
      .join('\n');
  }

  private buildSystemPrompt(rulesSummary: string, context: OpsPromptContext): string {
    const isProd = context.targetEnvironment === 'production';
    const highRiskNote = isProd
      ? `\n\n## 高危发布警告
- 目标环境: **生产环境**（production）
- 此操作属于 **G4 高危动作**，必须经过双人审批（Release Manager + Security Officer）
- 未完成审批前不得触发任何部署动作
- 审批通过后，必须以 deploy-token 授权执行，不得直接使用永久凭证`
      : '';

    const canaryNote = context.canaryMetrics
      ? `\n\n## 金丝雀指标
${context.canaryMetrics}
请基于上述指标判断是否满足生产发布条件。`
      : '';

    return `你是一名专业的运维工程师（Ops-Agent）。你的职责是准备发布清单（变更 Diff + 回滚预案），申请 deploy-token，并在审批通过后安全触发部署。

## 发布规则集（必须遵守）
${rulesSummary}

## 输出要求
- 必须以 JSON 格式输出
- 必须包含 changeDiff、rollbackPlan、deployTokenRequest、summary、riskLevel、traceSpanId 字段
- riskLevel 必须是 G1/G2/G3/G4 之一
- traceSpanId 用于审计归因，必须有效
- summary 不超过 500 字
- deploy-token TTL 不得超过 900 秒（15 分钟）

## 约束
- 不得绕过 PolicyEngine 直接调用部署工具
- 所有工具调用必须经过内核拦截后走 Policy 裁决
- G4 高危发布未完成双人审批前禁止触发部署
- 必须在发布失败时支持 emergencyFreeze${highRiskNote}${canaryNote}`;
  }

  private buildUserPrompt(context: OpsPromptContext): string {
    const filesList = context.changedFiles.map((f) => `- ${f}`).join('\n');
    let prompt = `请为以下变更准备发布清单：

**标题**: ${context.prTitle}
**描述**: ${context.prDescription}
**风险级别**: ${context.riskLevel}
**目标环境**: ${context.targetEnvironment}
**变更文件** (${context.changedFiles.length} 个):
${filesList}`;

    if (context.diffSummary) {
      prompt += `\n\n**变更 Diff 摘要**:
${context.diffSummary}`;
    }

    if (context.rollbackPlan) {
      prompt += `\n\n**已有回滚预案**:
${context.rollbackPlan}`;
    }

    if (context.canaryMetrics) {
      prompt += `\n\n**金丝雀指标**:
${context.canaryMetrics}`;
    }

    if (context.deployTarget) {
      prompt += `\n\n**部署目标**: ${context.deployTarget}`;
    }

    if (context.tokenTtlSeconds) {
      prompt += `\n\n**Token TTL**: ${context.tokenTtlSeconds} 秒`;
    }

    if (context.extraContext) {
      prompt += `\n\n**额外上下文**: ${context.extraContext}`;
    }

    prompt += '\n\n请以 JSON 格式输出发布准备结果。';
    return prompt;
  }
}
