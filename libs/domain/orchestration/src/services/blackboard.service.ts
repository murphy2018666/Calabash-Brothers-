/**
 * BlackboardService —— Blackboard 应用服务（OR 域）
 *
 * 对应设计文档：
 * - detailed-design §4.6.2 M1 黑板模式 / §4.5 上下文分层
 * - ADD §4 三条内核不变量之 "Agent 间通信必走 Blackboard"
 *
 * 职责：
 * - 管理 Run 级 BlackboardSession 聚合根的生命周期。
 * - 提供唯一写入入口 append（强制 contributor = 调用方自身 agentId，不可伪造他人）。
 * - 提供 dispatch 时的快照注入 read（供 AgentContext，受压缩策略管控）。
 * - 发布 BlackboardEntryAdded 事件（M1 通道）。
 *
 * 不变量（service 侧强制）：
 * - 任何路径都不得暴露/读取 AgentContext —— 跨 Agent 信息交换只走黑板。
 * - 条目 append-only，写入即固化到审计域（WORM，由审计域订阅事件完成）。
 * - 结构化 JSON 存储，summary ≤200 字，防 Prompt 注入扩散。
 */
import { Injectable, Inject, Logger } from '@nestjs/common';
import type { DomainEvent } from '@aegisci/shared/types';
import {
  BlackboardSession,
  AppendBlackboardEntryCommand,
  BlackboardReadFilter,
  BlackboardSnapshot,
  BlackboardEntryPayload,
} from '../aggregates/blackboard.aggregate';
import {
  OR_EVENT_TYPES,
  BlackboardEntryAddedEvent,
  BlackboardEntryAddedPayload,
} from '../events/orchestration-events';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 事件发布端口（可由 NATS / EventEmitter2 实现，本骨架以端口解耦）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const OR_EVENT_PUBLISHER = Symbol('OR_EVENT_PUBLISHER');

export interface OrEventPublisher {
  publish<T>(event: DomainEvent<T>): Promise<void> | void;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Blackboard 仓储端口（实现可为 in-memory / Redis / PG）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const BLACKBOARD_REPOSITORY = Symbol('BLACKBOARD_REPOSITORY');

export interface BlackboardRepository {
  save(session: BlackboardSession): Promise<void>;
  load(blackboardSessionId: string): Promise<BlackboardSession | null>;
  /** 按 runId 获取该 Run 的黑板会话（Run 级 1:1） */
  loadByRun(runId: string): Promise<BlackboardSession | null>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class BlackboardService {
  private readonly logger = new Logger(BlackboardService.name);

  constructor(
    @Inject(BLACKBOARD_REPOSITORY) private readonly repo: BlackboardRepository,
    @Inject(OR_EVENT_PUBLISHER) private readonly publisher: OrEventPublisher,
  ) {}

  /** 为 Run 初始化黑板会话（Run 创建→完成生命周期） */
  async openSession(runId: string): Promise<BlackboardSession> {
    const existing = await this.repo.loadByRun(runId);
    if (existing) return existing;
    const blackboardSessionId = `bbs_${runId}_${Date.now().toString(36)}`;
    const session = BlackboardSession.create(blackboardSessionId, runId);
    await this.repo.save(session);
    this.logger.log(`BlackboardSession opened: ${blackboardSessionId} for run ${runId}`);
    return session;
  }

  /**
   * 追加条目 —— 唯一写入入口。
   * @param callerAgentId 调用方 agentId（由 dispatcher 在 Agent 上下文中注入，不可由调用方伪造他人）。
   *                     service 侧强制 cmd.contributor === callerAgentId。
   */
  async append(
    callerAgentId: string,
    cmd: Omit<AppendBlackboardEntryCommand, 'contributor'> & { contributor?: string },
    tenantId: string,
    traceSpanId: string,
  ): Promise<{ entryId: string; appended: boolean; event: BlackboardEntryAddedEvent }> {
    // 不变量：contributor 必须为调用方自身，禁止伪造他人
    const contributor = cmd.contributor ?? callerAgentId;
    if (contributor !== callerAgentId) {
      throw new Error(
        `Blackboard invariant violation: contributor(${contributor}) != caller(${callerAgentId}); agents may only append their own entries`,
      );
    }

    const session = await this.repo.loadByRun(cmd.runId);
    if (!session) {
      throw new Error(`BlackboardSession not found for run ${cmd.runId}`);
    }

    const fullCmd: AppendBlackboardEntryCommand = {
      runId: cmd.runId,
      contributor,
      entryType: cmd.entryType,
      payload: cmd.payload,
      traceSpanId,
      delegatedBy: cmd.delegatedBy,
    };

    const { entry, appended } = session.append(fullCmd);
    await this.repo.save(session);

    const payload: BlackboardEntryAddedPayload = {
      runId: cmd.runId,
      blackboardSessionId: session.blackboardSessionId,
      entryId: entry.entryId,
      contributor,
      entryType: cmd.entryType,
      severity: cmd.payload.severity,
      traceSpanId,
      idempotencyKey: `${cmd.runId}|${contributor}|${this.hashSummary(cmd.payload.summary)}`,
    };

    const event: BlackboardEntryAddedEvent = {
      eventId: `evt_bbadd_${entry.entryId}`,
      eventType: OR_EVENT_TYPES.BLACKBOARD_ENTRY_ADDED,
      aggregateId: session.blackboardSessionId,
      aggregateType: 'BlackboardSession',
      tenantId,
      payload,
      timestamp: entry.timestamp,
      traceId: cmd.runId,
      spanId: traceSpanId,
    };
    await this.publisher.publish(event);

    if (appended) {
      this.logger.log(`Blackboard entry appended: ${entry.entryId} by ${contributor}`);
    } else {
      this.logger.log(`Blackboard entry idempotent hit: ${entry.entryId} by ${contributor}`);
    }
    return { entryId: entry.entryId, appended, event };
  }

  /**
   * 读取黑板快照（供 Agent dispatch 注入 AgentContext）。
   * 注意：仅返回结构化条目，**绝不返回任何 AgentContext**——跨 Agent 信息交换只走黑板。
   */
  async read(runId: string, filter?: BlackboardReadFilter): Promise<BlackboardSnapshot> {
    const session = await this.repo.loadByRun(runId);
    if (!session) {
      throw new Error(`BlackboardSession not found for run ${runId}`);
    }
    return session.read(filter);
  }

  /** 结构化摘要读取：按 entryType/severity/tags 过滤，避免无关信息污染上下文 */
  async readFiltered(
    runId: string,
    filter: BlackboardReadFilter,
  ): Promise<BlackboardEntryPayload[]> {
    const snapshot = await this.read(runId, filter);
    return snapshot.entries.map((e) => e.payload as unknown as BlackboardEntryPayload);
  }

  private hashSummary(summary: string): string {
    let h = 5381;
    for (let i = 0; i < summary.length; i++) {
      h = (h * 33) ^ summary.charCodeAt(i);
    }
    return (h >>> 0).toString(16);
  }
}
