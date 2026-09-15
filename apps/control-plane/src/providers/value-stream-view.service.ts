/**
 * E8-1: ValueStreamViewService —— 价值流视图聚合服务（G2）
 *
 * 职责：
 * - 聚合多域数据（Pipeline/Orchestration/Policy/Approval/Audit）生成价值流视图
 * - 提供流水线全生命周期进度（Trigger → Plan → Agent 编排 → Gate 审批 → Deploy → Verify）
 * - 计算关键指标（MTTR、通过率、审批延迟等）
 * - 支持按租户、时间窗口、流水线维度查询
 *
 * 对应设计文档：
 * - DES-7: 价值流视图与看板 G2
 * - DES-8: 性能指标（策略 P95<5ms，熔断 ≤10s）
 * - FR-M3-05: G4 高危动作需双人审批
 *
 * 数据来源：
 * - InMemoryTaskPlanRepository（任务计划状态）
 * - InMemoryGateRepository（门禁状态）
 * - InMemoryApprovalRepository（审批工单）
 * - AuditRetrievalService（审计数据）
 */
import { Injectable, Logger, Inject } from '@nestjs/common';
import type { TaskPlan, TaskPlanState } from '@aegisci/domain/orchestration';
import type { GateRecord } from '@aegisci/domain/pipeline';
import type { ApprovalTicketSnapshot } from './in-memory-approval-repository';
import type { AuditSummary } from './audit-retrieval.service';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 价值流阶段定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type StreamStage =
  | 'triggered'
  | 'planned'
  | 'reviewing'
  | 'testing'
  | 'security'
  | 'approved'
  | 'deploying'
  | 'deployed'
  | 'verified'
  | 'blocked'
  | 'failed'
  | 'rolled_back';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 价值流条目
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ValueStreamEntry {
  /** 流水線運行 ID */
  runId: string;
  /** 租户 ID */
  tenantId: string;
  /** 触发来源（PR / schedule / manual） */
  triggerSource: string;
  /** 当前阶段 */
  currentStage: StreamStage;
  /** 阶段进度（0.0 ~ 1.0） */
  progress: number;
  /** 流水线标题 */
  pipelineTitle: string;
  /** PR 关联（如有） */
  prRef?: string;
  /** 发起者 */
  initiator: string;
  /** 创建时间 */
  createdAt: string;
  /** 最近更新时间 */
  updatedAt: string;
  /** 预计完成时间 */
  estimatedCompletion?: string;
  /** 阻塞原因（如有） */
  blockReason?: string;
  /** 风险级别 */
  riskLevel?: string;
  /** 审批信息（如有） */
  approvalInfo?: {
    ticketId: string;
    requiredQuorum: number;
    currentVotes: number;
    state: string;
  };
  /** 门禁信息（如有） */
  gateInfo?: {
    gateId: string;
    decision: string;
    blockedBy: string;
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 价值流视图（汇总）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ValueStreamView {
  /** 租户 ID */
  tenantId: string;
  /** 查询时间窗口 */
  from: string;
  to: string;
  /** 活跃运行列表 */
  activeRuns: ValueStreamEntry[];
  /** 历史完成运行（最近 N 条） */
  completedRuns: ValueStreamEntry[];
  /** 统计概览 */
  summary: {
    totalRuns: number;
    activeCount: number;
    completedCount: number;
    failedCount: number;
    blockedCount: number;
    avgDurationMs: number;
    successRate: number;
    p95DurationMs: number;
  };
  /** 审计摘要 */
  auditSummary?: AuditSummary;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 仓库端口
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface ValueStreamRepositories {
  taskPlanRepo: { loadByRun(runId: string): Promise<TaskPlan | null>; listAll(): Promise<TaskPlan[]> };
  gateRepo: { load(gateId: string): Promise<GateRecord | null>; listByRun(runId: string): Promise<GateRecord[]> };
  approvalRepo: { load(ticketId: string): Promise<ApprovalTicketSnapshot | null>; listOpen(tenantId: string): Promise<ApprovalTicketSnapshot[]> };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class ValueStreamViewService {
  private readonly logger = new Logger(ValueStreamViewService.name);

  constructor(@Inject('ValueStreamRepositories') private readonly repos: ValueStreamRepositories) {}

  /**
   * 获取租户价值流视图。
   * 聚合任务计划、门禁、审批、审计数据生成完整视图。
   */
  async getView(
    tenantId: string,
    from: string,
    to: string,
    options: { limit?: number; includeCompleted?: boolean } = {},
  ): Promise<ValueStreamView> {
    const start = Date.now();

    // 获取所有任务计划
    const allPlans = await this.repos.taskPlanRepo.listAll();
    const tenantPlans = allPlans.filter((p) => p.tenantId === tenantId);

    // 获取所有门禁
    const allGates = new Map<string, GateRecord[]>();
    for (const plan of tenantPlans) {
      const gates = await this.repos.gateRepo.listByRun(plan.runId);
      if (gates.length > 0) {
        allGates.set(plan.runId, gates);
      }
    }

    // 获取开放审批工单（按租户过滤，防止跨租户越权）
    const openApprovals = await this.repos.approvalRepo.listOpen(tenantId);
    const approvalByRun = new Map<string, ApprovalTicketSnapshot[]>();
    for (const approval of openApprovals) {
      const runId = approval.evidenceId.split('_')[0]; // 简化：从 evidenceId 提取 runId
      if (!approvalByRun.has(runId)) {
        approvalByRun.set(runId, []);
      }
      approvalByRun.get(runId)!.push(approval);
    }

    // 构建价值流条目
    const activeRuns: ValueStreamEntry[] = [];
    const completedRuns: ValueStreamEntry[] = [];

    for (const plan of tenantPlans) {
      if (plan.createdAt < from || plan.createdAt > to) continue;

      const entry = this.buildEntry(plan, allGates.get(plan.runId), approvalByRun.get(plan.runId));
      if (entry.currentStage === 'failed' || entry.currentStage === 'rolled_back' || entry.currentStage === 'verified') {
        completedRuns.push(entry);
      } else {
        activeRuns.push(entry);
      }
    }

    // 统计（只统计在时间范围内的计划）
    const filteredPlans = tenantPlans.filter((p) => p.createdAt >= from && p.createdAt <= to);
    const durations = completedRuns.map((r) => this.calcDuration(r));
    const successCount = completedRuns.filter((r) => r.currentStage === 'verified').length;
    const failedCount = completedRuns.filter((r) => r.currentStage === 'failed').length;
    const blockedCount = activeRuns.filter((r) => r.currentStage === 'blocked').length;

    const queryMs = Date.now() - start;
    this.logger.debug(
      `Value stream view generated: ${activeRuns.length} active, ${completedRuns.length} completed in ${queryMs}ms`,
    );

    return {
      tenantId,
      from,
      to,
      activeRuns,
      completedRuns: completedRuns.slice(-20), // 最近 20 条
      summary: {
        totalRuns: filteredPlans.length,
        activeCount: activeRuns.length,
        completedCount: completedRuns.length,
        failedCount,
        blockedCount,
        avgDurationMs: durations.length > 0 ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : 0,
        successRate: completedRuns.length > 0 ? Math.round((successCount / completedRuns.length) * 100) : 0,
        p95DurationMs: durations.length > 0 ? this.p95(durations) : 0,
      },
    };
  }

  /**
   * 获取单个运行的价值流详情。
   */
  async getRunView(
    tenantId: string,
    runId: string,
  ): Promise<ValueStreamEntry | null> {
    const plan = await this.repos.taskPlanRepo.loadByRun(runId);
    if (!plan || plan.tenantId !== tenantId) return null;

    const gates = await this.repos.gateRepo.listByRun(runId);
    const entries = await this.repos.approvalRepo.listOpen();
    const runApprovals = entries.filter((a) => a.evidenceId.startsWith(runId));

    return this.buildEntry(plan, gates, runApprovals);
  }

  /**
   * 构建价值流条目。
   */
  private buildEntry(
    plan: TaskPlan,
    gates: GateRecord[] | undefined,
    approvals: ApprovalTicketSnapshot[] | undefined,
  ): ValueStreamEntry {
    const currentStage = this.determineStage(plan.state, gates, approvals);
    const progress = this.calcProgress(plan.state, gates, approvals);

    return {
      runId: plan.runId,
      tenantId: plan.tenantId,
      triggerSource: plan.triggerSource ?? 'manual',
      currentStage,
      progress,
      pipelineTitle: plan.pipelineTitle ?? 'Untitled Pipeline',
      prRef: plan.prRef,
      initiator: plan.initiator,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
      estimatedCompletion: plan.estimatedCompletion,
      blockReason: this.getBlockReason(plan.state, gates, approvals),
      riskLevel: plan.riskLevel,
      approvalInfo: approvals && approvals.length > 0 ? {
        ticketId: approvals[0].ticketId,
        requiredQuorum: approvals[0].requiredQuorum,
        currentVotes: approvals[0].votes.length,
        state: approvals[0].state,
      } : undefined,
      gateInfo: gates && gates.length > 0 ? {
        gateId: gates[0].gateId,
        decision: gates[0].decision ?? 'pending',
        blockedBy: gates[0].blockedBy,
      } : undefined,
    };
  }

  /**
   * 确定当前阶段。
   */
  private determineStage(
    planState: string,
    gates: GateRecord[] | undefined,
    approvals: ApprovalTicketSnapshot[] | undefined,
  ): StreamStage {
    // 检查是否有审批中的工单
    if (approvals?.some((a) => a.state === 'open')) {
      return 'approved';
    }

    // 检查是否有阻塞的门禁
    const blockedGate = gates?.find((g) => g.state === 'blocked');
    if (blockedGate) {
      return 'blocked';
    }

    switch (planState) {
      case 'planned':
        return 'planned';
      case 'reviewing':
        return 'reviewing';
      case 'testing':
        return 'testing';
      case 'security_check':
        return 'security';
      case 'deploying':
        return 'deploying';
      case 'deployed':
        return 'deployed';
      case 'verified':
        return 'verified';
      case 'failed':
        return 'failed';
      case 'rolled_back':
        return 'rolled_back';
      default:
        return 'triggered';
    }
  }

  /**
   * 计算进度。
   */
  private calcProgress(planState: string, gates: GateRecord[] | undefined, approvals: ApprovalTicketSnapshot[] | undefined): number {
    if (approvals?.some((a) => a.state === 'open')) return 0.7;
    if (gates?.some((g) => g.state === 'blocked')) return 0.65;

    const stageProgress: Record<string, number> = {
      planned: 0.1,
      reviewing: 0.25,
      testing: 0.4,
      security_check: 0.55,
      approved: 0.7,
      deploying: 0.8,
      deployed: 0.9,
      verified: 1.0,
      failed: 1.0,
      rolled_back: 1.0,
    };
    return stageProgress[planState] ?? 0.0;
  }

  /**
   * 获取阻塞原因。
   */
  private getBlockReason(
    planState: string,
    gates: GateRecord[] | undefined,
    approvals: ApprovalTicketSnapshot[] | undefined,
  ): string | undefined {
    const blockedGate = gates?.find((g) => g.state === 'blocked');
    if (blockedGate) {
      return blockedGate.blockedBy || 'Pending approval';
    }
    if (approvals?.some((a) => a.state === 'open')) {
      return 'Waiting for approval (quorum not reached)';
    }
    return undefined;
  }

  /**
   * 计算运行持续时间（毫秒）。
   */
  private calcDuration(entry: ValueStreamEntry): number {
    const start = new Date(entry.createdAt).getTime();
    const end = entry.currentStage === 'failed' || entry.currentStage === 'rolled_back'
      ? new Date(entry.updatedAt).getTime()
      : Date.now();
    return end - start;
  }

  /**
   * 计算 P95 值。
   */
  private p95(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.ceil(sorted.length * 0.95) - 1;
    return sorted[idx];
  }
}
