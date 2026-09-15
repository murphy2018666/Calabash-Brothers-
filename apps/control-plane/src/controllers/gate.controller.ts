import { randomUUID } from 'crypto';
import {
  Body,
  Controller,
  Inject,
  NotFoundException,
  Param,
  Post,
  Req,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { DomainEvent, Principal } from '@aegisci/shared/types';
import {
  PIPELINE_TOKENS,
  GateAggregate,
  IllegalGateTransitionError,
  type GateRepositoryPort,
  type GateRecord,
} from '@aegisci/domain/pipeline';
import { AuditWormService } from '@aegisci/domain/audit';
import { AgentDispatcherService } from '@aegisci/domain/orchestration';

/** HITL 审批请求载荷 */
export interface GateApproveBody {
  /** 审批人主体 ID（由 AuthGuard 注入 principal.id） */
  approvedBy: string;
  /** 审批工单 ID（PO 系统下发的 Ticket ID，用于审计追踪） */
  approvalTicketId: string;
}

/** 审批响应 */
export interface GateApproveResponse {
  gateId: string;
  decision: 'hitl' | 'auto' | 'blocked' | 'pending';
  approvedBy: string;
  events: Array<{ type: string; payload: Record<string, unknown> }>;
  auditSealed: boolean;
}

/**
 * GateController —— HITL 人工介入接口（D2-4）。
 *
 * 职责：
 *  1. POST /gates/:gateId/approve — 审批被打断的门禁，固化 Audit WORM
 *  2. GET  /gates/:gateId          — 查询门禁当前状态（只读）
 *
 * 不变式：
 *  - Gate 状态为 'blocked' 才可审批（非法转换抛 IllegalGateTransitionError → 409）
 *  - 每次审批必须固化一条 AuditEnvelope 到 WORM（内核不变量：EVERY_GATE_APPROVAL_AUDITED）
 *  - approve 成功后将 GatePassed 事件桥接回 OR（通过 AgentDispatcherService.onGateResult）
 */
@Controller('gates')
export class GateController {
  constructor(
    @Inject(PIPELINE_TOKENS.GATE_REPOSITORY)
    private readonly repo: GateRepositoryPort,
    @Inject(AgentDispatcherService)
    private readonly dispatcher: AgentDispatcherService,
    private readonly audit: AuditWormService,
  ) {}

  /**
   * HITL 审批入口：POST /gates/:gateId/approve
   *
   * 处理流程：
   *  1. 从仓库加载 GateRecord
   *  2. rehydrate GateAggregate
   *  3. 调用 approve(params) 执行状态转换 + 发布事件
   *  4. 持久化更新后的 GateRecord（包含未提交事件后的新快照）
   *  5. 固化每条门禁事件到 WORM Audit
   *  6. 桥接 GatePassed 回 OR（onGateResult）
   */
  @Post(':gateId/approve')
  async approve(
    @Param('gateId') gateId: string,
    @Body() body: GateApproveBody,
    @Req() req: { user?: Principal },
  ): Promise<GateApproveResponse> {
    // ── 1. 加载 Gate 快照 ──
    const snapshot = await this.repo.load(gateId);
    if (!snapshot) {
      throw new NotFoundException(`Gate not found: ${gateId}`);
    }

    // ── 2. 鉴权：approvedBy 必须与请求 Principal 匹配（防止越权审批） ──
    const principal = req?.user;
    if (!principal || principal.id !== body.approvedBy) {
      throw new UnauthorizedException(
        `Approval principal mismatch: request user=${principal?.id ?? 'none'} != approvedBy=${body.approvedBy}`,
      );
    }
    if (!body.approvalTicketId) {
      throw new UnprocessableEntityException('approvalTicketId is required');
    }

    // ── 3. Rehydrate + approve ──
    const gate = GateAggregate.rehydrate(snapshot, createStubEventContext());
    gate.approve({
      approvalTicketId: body.approvalTicketId,
      approvedBy: principal.id,
    });

    // ── 4. 持久化新快照 ──
    const newSnapshot = gate.snapshot;
    await this.repo.save(newSnapshot);

    // ── 5. WORM 审计固化 ──
    const uncommitted = [...gate.uncommittedEvents];
    gate.markEventsCommitted();
    const sealedResults = await Promise.all(
      uncommitted.map((evt) => this.sealAuditEnvelope(evt, principal, newSnapshot)),
    );

    // ── 6. 桥接 GatePassed 回 OR → onGateResult → TaskPlan Done ──
    const passedEvents = uncommitted.filter(
      (e) => e.eventType === 'pipeline.gate.passed',
    );
    for (const evt of passedEvents) {
      const payload = evt.payload as Record<string, unknown>;
      const taskPlanId = payload.runId ? `gate_${payload.runId}` : gateId;
      void this.dispatcher.onGateResult(taskPlanId);
    }

    return {
      gateId,
      decision: newSnapshot.decision ?? 'pending',
      approvedBy: principal.id,
      events: uncommitted.map((e) => ({ type: e.eventType, payload: e.payload as Record<string, unknown> })),
      auditSealed: sealedResults.every((r) => r.sealed),
    };
  }

  /** 查询门禁状态：GET /gates/:gateId */
  async getGate(gateId: string): Promise<GateRecord & { decision?: string }> {
    const snapshot = await this.repo.load(gateId);
    if (!snapshot) {
      throw new NotFoundException(`Gate not found: ${gateId}`);
    }
    return { ...snapshot, decision: snapshot.decision };
  }

  // ── 内部 ──

  private async sealAuditEnvelope(
    evt: DomainEvent<unknown>,
    principal: Principal,
    snapshot: GateRecord,
  ): Promise<{ sealed: boolean; objectKey: string }> {
    try {
      const envelope = {
        envelopeId: `env_gate_${randomUUID()}`,
        tenantId: snapshot.tenantId,
        principalId: principal.id,
        principalType: principal.type,
        action: evt.eventType,
        resource: `gate:${snapshot.gateId}`,
        evidenceId: evt.eventId,
        traceSpanId: evt.spanId ?? 'root',
        result: evt.eventType.includes('passed') ? ('success' as const) : ('denied' as const),
        timestamp: evt.timestamp,
        metadata: { gateId: snapshot.gateId, runId: snapshot.runId, eventType: evt.eventType },
      };
      await this.audit.seal(envelope);
      return { sealed: true, objectKey: `audit/${snapshot.tenantId}/${envelope.timestamp.slice(0, 10)}/${envelope.envelopeId}.json` };
    } catch {
      return { sealed: false, objectKey: '' };
    }
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 辅助
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function createStubEventContext() {
  return {
    nextEventId: () => `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    now: () => new Date().toISOString(),
    traceId: 'gate-stub',
    spanId: 'gate-stub-span',
  };
}
