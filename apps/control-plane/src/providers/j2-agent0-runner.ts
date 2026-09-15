/**
 * Agent-0 试运行框架 (J2)
 *
 * 设计目标：为 Beta POC 客户提供一个最小可用的 Agent 试运行环境，
 * 包括：Agent 注册、权限绑定、工具调用审计、试运行报告生成。
 *
 * 对应文档：
 * - S8 启动 / S9 完成 J2
 * - WBS J2：Beta客户POC与报告
 */
import { Injectable, Logger } from '@nestjs/common';
import type { AgentCard } from '@aegisci/shared/types';
import type { TraceSpan } from '@aegisci/core/spi/trace';

/**
 * TrialPhase —— 试运行阶段
 */
export type TrialPhase = 'registration' | 'sandbox' | 'shadow' | 'active' | 'reported';

/**
 * TrialRun —— 单次试运行实例
 */
export interface TrialRun {
  trialId: string;
  tenantId: string;
  agentId: string;
  phase: TrialPhase;
  startedAt: string;
  completedAt?: string;
  /** 试运行中执行的工具调用次数 */
  toolCallCount: number;
  /** 试运行中策略拒绝次数 */
  denyCount: number;
  /** 试运行中产生的 TraceSpans */
  spans: TraceSpan[];
  /** 试运行结论 */
  conclusion?: string;
  /** 风险等级 */
  riskLevel?: 'G1' | 'G2' | 'G3' | 'G4';
}

/**
 * TrialReport —— 试运行报告
 */
export interface TrialReport {
  trialId: string;
  tenantId: string;
  agentId: string;
  agentCard: AgentCard;
  phase: TrialPhase;
  stats: {
    totalToolCalls: number;
    totalDenies: number;
    totalSpans: number;
    avgSpanDurationMs: number;
  };
  recommendations: string[];
  riskAssessment: string;
  generatedAt: string;
}

@Injectable()
export class Agent0TrialFramework {
  private readonly logger = new Logger(Agent0TrialFramework.name);
  private readonly trials = new Map<string, TrialRun>();
  private readonly agents = new Map<string, AgentCard>();

  /**
   * registerAgent —— 注册试运行 Agent
   */
  registerAgent(card: AgentCard): void {
    this.agents.set(card.agentId, card);
    this.logger.log(`[Agent0] registerAgent agentId=${card.agentId} role=${card.role} tier=${card.riskTier}`);
  }

  /**
   * startTrial —— 启动试运行
   */
  startTrial(params: {
    tenantId: string;
    agentId: string;
    riskLevel?: 'G1' | 'G2' | 'G3' | 'G4';
  }): string {
    const { tenantId, agentId, riskLevel } = params;
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`[Agent0] agentId=${agentId} not registered`);
    }
    const trialId = `trial-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const trial: TrialRun = {
      trialId,
      tenantId,
      agentId,
      phase: 'sandbox',
      startedAt: new Date().toISOString(),
      toolCallCount: 0,
      denyCount: 0,
      spans: [],
      riskLevel: riskLevel ?? agent.riskTier,
    };
    this.trials.set(trialId, trial);
    this.logger.log(`[Agent0] startTrial trialId=${trialId} tenantId=${tenantId} agentId=${agentId}`);
    return trialId;
  }

  /**
   * recordToolCall —— 记录一次工具调用（试运行中）
   */
  recordToolCall(params: {
    trialId: string;
    span: TraceSpan;
    denied?: boolean;
  }): void {
    const trial = this.trials.get(params.trialId);
    if (!trial) {
      throw new Error(`[Agent0] trialId=${params.trialId} not found`);
    }
    trial.toolCallCount += 1;
    if (params.denied) trial.denyCount += 1;
    trial.spans.push(params.span);
  }

  /**
   * advancePhase —— 推进试运行阶段
   */
  advancePhase(trialId: string, phase: TrialPhase): void {
    const trial = this.trials.get(trialId);
    if (!trial) throw new Error(`[Agent0] trialId=${trialId} not found`);
    const phaseOrder: TrialPhase[] = ['registration', 'sandbox', 'shadow', 'active', 'reported'];
    const currentIndex = phaseOrder.indexOf(trial.phase);
    const targetIndex = phaseOrder.indexOf(phase);
    if (targetIndex <= currentIndex) {
      throw new Error(`[Agent0] cannot regress from ${trial.phase} to ${phase}`);
    }
    trial.phase = phase;
    if (phase === 'reported') {
      trial.completedAt = new Date().toISOString();
    }
    this.logger.log(`[Agent0] advancePhase trialId=${trialId} → ${phase}`);
  }

  /**
   * generateReport —— 生成试运行报告
   */
  generateReport(trialId: string): TrialReport {
    const trial = this.trials.get(trialId);
    if (!trial) throw new Error(`[Agent0] trialId=${trialId} not found`);
    const agent = this.agents.get(trial.agentId);
    if (!agent) throw new Error(`[Agent0] agentId=${trial.agentId} not found`);

    const durations = trial.spans.map((s) => (s.endTime ?? Date.now()) - s.startTime);
    const avgDuration = durations.length > 0
      ? durations.reduce((a, b) => a + b, 0) / durations.length
      : 0;

    const recommendations: string[] = [];
    if (trial.denyCount > 0) {
      recommendations.push(`策略拒绝 ${trial.denyCount} 次，建议审查 Agent 权限范围`);
    }
    if (avgDuration > 5000) {
      recommendations.push(`平均工具调用耗时 ${avgDuration.toFixed(0)}ms，建议优化 LLM 请求或增加缓存`);
    }
    if (trial.spans.length === 0) {
      recommendations.push('试运行期间无工具调用记录，确认 Agent 已正确配置能力');
    }

    const riskAssessment = this.assessRisk(trial);

    return {
      trialId,
      tenantId: trial.tenantId,
      agentId: trial.agentId,
      agentCard: agent,
      phase: trial.phase,
      stats: {
        totalToolCalls: trial.toolCallCount,
        totalDenies: trial.denyCount,
        totalSpans: trial.spans.length,
        avgSpanDurationMs: Math.round(avgDuration),
      },
      recommendations,
      riskAssessment,
      generatedAt: new Date().toISOString(),
    };
  }

  /**
   * getTrial —— 获取试运行实例
   */
  getTrial(trialId: string): TrialRun | undefined {
    return this.trials.get(trialId);
  }

  /**
   * getAgent —— 获取注册 Agent
   */
  getAgent(agentId: string): AgentCard | undefined {
    return this.agents.get(agentId);
  }

  // ── 私有方法 ──────────────────────────────────────────────────────

  private assessRisk(trial: TrialRun): string {
    const { denyCount, toolCallCount, riskLevel } = trial;
    const denyRatio = toolCallCount > 0 ? denyCount / toolCallCount : 0;

    if (denyRatio > 0.5) return `高风险：拒绝率 ${((denyRatio * 100)).toFixed(1)}%，建议暂停试运行并审查 Agent 配置`;
    if (denyRatio > 0.2) return `中风险：拒绝率 ${((denyRatio * 100)).toFixed(1)}%，建议调整 Agent 权限边界`;
    if (riskLevel === 'G4') return 'G4级运行中，仅允许沙箱模式';
    return '风险可控，建议进入下一阶段';
  }
}
