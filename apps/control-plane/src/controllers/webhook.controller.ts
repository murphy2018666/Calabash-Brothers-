import { randomUUID } from 'crypto';
import {
  Body,
  Controller,
  Inject,
  Post,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Run, RunTrigger } from '@aegisci/shared/types';
import {
  PIPELINE_TOKENS,
  type RunAggregateFactory,
  type RunRepositoryPort,
} from '@aegisci/domain/pipeline';
import { IdentityService } from '@aegisci/domain/identity';
import { InMemoryRunRepository } from '../providers/in-memory-run-repository';

/**
 * Git webhook 入站事件载荷契约。
 * 对齐主流 Git 平台（GitHub/GitLab/Bitbucket）push / MR / tag / schedule 事件的最小公共字段。
 */
export interface GitWebhookBody {
  /** 事件类型：push=分支推送 / mr=合并请求 / tag=标签创建 / schedule=定时 / api=API 触发 */
  event?: 'push' | 'mr' | 'tag' | 'schedule' | 'api';
  /** 仓库全名（owner/repo） */
  repo?: string;
  /** 引用（分支名 / 标签名 / MR 源分支） */
  ref?: string;
  /** 触发者主体标识（Principal.id，由 webhook 签名验证后映射） */
  actor?: string;
  /** 提交 SHA（push/tag 必填，schedule 可用默认分支 HEAD 占位） */
  commit?: string;
  /** 可选：MR / Schedule 携带的额外字段 */
  mrId?: string;
  /** 可选：覆盖默认 pipelineId（否则按 repo 派生） */
  pipelineId?: string;
  /** 可选：覆盖租户（否则以 actor 主体所属租户为准） */
  tenantId?: string;
}

/** Webhook 处理响应 */
export interface GitWebhookResponse {
  runId: string;
  status: Run['status'];
  received: boolean;
  deduplicated: boolean;
  trigger: RunTrigger;
}

/**
 * WebhookController —— 接收 Git 事件并创建 Run（PL 域聚合根）。
 * POST /webhook/git
 *
 * 处理流程（对应 D1-1 / D1-4 / D1-5）：
 *  1. 解析事件类型与触发字段（push/mr/tag/schedule/api）
 *  2. 主体鉴权：actor 必须是已注册 Principal（IdentityService.lookup）
 *  3. 幂等去重：dedupKey = repo+ref+commit+event_type，命中则返回既有 runId
 *  4. 经 RunAggregateFactory 创建 Run 聚合根（写者恒为 PL，铁律 1）
 *  5. 持久化快照至 RunRepositoryPort（控制面重启后可恢复 in-progress Run）
 *
 * 不变式：
 * - 不直接修改 Run.status（仅聚合根 + 状态机可写）
 * - actor 未通过主体校验 → 401 UnauthorizedException
 * - 必填字段缺失 → 422 UnprocessableEntityException
 */
@Controller('webhook')
export class WebhookController {
  constructor(
    @Inject(PIPELINE_TOKENS.RUN_AGGREGATE_FACTORY)
    private readonly factory: RunAggregateFactory,
    @Inject(PIPELINE_TOKENS.RUN_REPOSITORY)
    private readonly repo: RunRepositoryPort,
    private readonly identity: IdentityService,
    /**
     * 注入具体实现以使用去重查询（findByDedupKey/registerDedupKey）。
     * 仓储接口（RunRepositoryPort）仅声明 load/save；
     * 去重索引是控制面内部持久化能力，未来 PG 实现应同样提供。
     */
    private readonly dedup: InMemoryRunRepository,
  ) {}

  @Post('git')
  async webhookGit(
    @Body() body: GitWebhookBody,
  ): Promise<GitWebhookResponse> {
    // ── 1. 解析与字段校验 ──
    const trigger = this.parseTrigger(body);

    // ── 2. 主体鉴权（D1-4）：actor 必须是已注册 Principal ──
    const principal = await this.identity.lookup(trigger.actor);
    if (!principal) {
      throw new UnauthorizedException(
        `Webhook actor '${trigger.actor}' is not a registered principal`,
      );
    }

    // ── 3. 幂等去重（D1-5）：repo+ref+commit+event_type ──
    const dedupKey = this.buildDedupKey(trigger);
    const existing = await this.dedup.findByDedupKey(dedupKey);
    if (existing) {
      return {
        runId: existing.runId,
        status: existing.status,
        received: true,
        deduplicated: true,
        trigger,
      };
    }

    // ── 4. 创建 Run 聚合根（写者 PL，铁律 1） ──
    const runId = `run_${randomUUID()}`;
    const tenantId = body.tenantId ?? principal.tenantId;
    const pipelineId =
      body.pipelineId ?? `pipeline_${trigger.repo.replace(/[/.]/g, '_')}`;
    const aggregate = this.factory.create({
      runId,
      tenantId,
      pipelineId,
      stage: 'trigger',
      trigger,
    });

    // ── 5. 持久化快照 + 登记去重键 ──
    const snapshot = aggregate.snapshot;
    await this.repo.save(snapshot);
    await this.dedup.registerDedupKey(dedupKey, runId);
    aggregate.markEventsCommitted();

    return {
      runId,
      status: snapshot.status,
      received: true,
      deduplicated: false,
      trigger,
    };
  }

  // ── 内部：解析触发字段 ──

  private parseTrigger(body: GitWebhookBody): RunTrigger {
    const event = body.event ?? 'push';
    const repo = (body.repo ?? '').trim();
    const ref = (body.ref ?? '').trim();
    const actor = (body.actor ?? '').trim();
    const commit = (body.commit ?? '').trim();

    if (!repo) {
      throw new UnprocessableEntityException('webhook body missing `repo`');
    }
    if (!ref) {
      throw new UnprocessableEntityException('webhook body missing `ref`');
    }
    if (!actor) {
      throw new UnprocessableEntityException('webhook body missing `actor`');
    }
    // schedule 事件允许无 commit（由控制面在派发时填充默认分支 HEAD）
    if (event !== 'schedule' && !commit) {
      throw new UnprocessableEntityException(
        `webhook body missing \`commit\` for event type '${event}'`,
      );
    }

    return { event, repo, ref, actor, commit: commit || undefined };
  }

  /** 幂等键：repo+ref+commit+event_type（D1-5 契约） */
  private buildDedupKey(t: RunTrigger): string {
    return [t.repo, t.ref, t.commit || '-', t.event].join('|');
  }
}
