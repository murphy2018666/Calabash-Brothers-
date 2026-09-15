import { Test } from '@nestjs/testing';
import {
  PIPELINE_TOKENS,
  RunStateMachine,
  type PipelineEventContext,
  type RunAggregateFactory,
} from '@aegisci/domain/pipeline';
import { RunAggregate } from '@aegisci/domain/pipeline';
import type { RunStage, RunTrigger } from '@aegisci/shared/types';
import {
  IdentityService,
  type PrincipalRecord,
  type PrincipalRepository,
} from '@aegisci/domain/identity';
import { InMemoryRunRepository } from '../providers/in-memory-run-repository';
import {
  WebhookController,
  type GitWebhookBody,
} from './webhook.controller';

/**
 * WebhookController 单元测试（D1-1 / D1-4 / D1-5）。
 *
 * 覆盖：
 * - push / mr / tag / schedule 事件解析
 * - 主体鉴权（actor 必须是已注册 Principal，未注册 → 401）
 * - 字段校验（缺 repo/ref/actor/commit → 422）
 * - 幂等去重（同 dedupKey 二次投递返回既有 runId）
 * - Run 经工厂创建并落库（snapshot 可经仓储 load 回读）
 *
 * 装配策略：手工构造 RunAggregateFactory（绑定真实 RunStateMachine + 桩 EVENT_CONTEXT），
 * 与 PipelineModule.useFactory 等价。IdentityService 使用真实实现，但其依赖的
 * PrincipalRepository 端口用最小内存桩注入（避免拖入 IdentityModule 全量装配）。
 */
describe('WebhookController', () => {
  let controller: WebhookController;
  let repo: InMemoryRunRepository;
  let identity: IdentityService;
  let principalId: string;

  beforeEach(async () => {
    const ctx: PipelineEventContext = {
      nextEventId: () => `evt_${Date.now()}_${Math.random().toString(36).slice(2)}`,
      now: () => new Date().toISOString(),
      traceId: 'test-trace',
      spanId: 'test-span',
    };
    const sm = new RunStateMachine();
    const factory: RunAggregateFactory = {
      create: (params: {
        runId: string;
        tenantId: string;
        pipelineId: string;
        stage: RunStage;
        trigger: RunTrigger;
      }) => RunAggregate.create(params, sm, ctx),
      rehydrate: () => {
        throw new Error('not used in webhook tests');
      },
    };

    repo = new InMemoryRunRepository();

    // 最小 PrincipalRepository 桩（内存 Map），仅满足 IdentityService 注册/查询路径
    const principalStore = new Map<string, PrincipalRecord>();
    const principalRepo: PrincipalRepository = {
      async save(record: PrincipalRecord) {
        principalStore.set(record.id, { ...record });
        return record;
      },
      async findById(id: string) {
        const hit = principalStore.get(id);
        return hit ? { ...hit } : null;
      },
      async findByTenant(tenantId: string) {
        return [...principalStore.values()].filter((p) => p.tenantId === tenantId);
      },
      async findByType(
        type: PrincipalRecord['type'],
        tenantId?: string,
      ) {
        return [...principalStore.values()].filter(
          (p) => p.type === type && (tenantId === undefined || p.tenantId === tenantId),
        );
      },
      async findByAgentCard(_agentCardId: string) {
        return null;
      },
      async delete(id: string) {
        return principalStore.delete(id);
      },
    };
    identity = new IdentityService(principalRepo);
    const principal = await identity.register(
      'service',
      'tenant-1',
      ['ci:trigger'],
      'ci-bot',
    );
    principalId = principal.id;

    const moduleRef = await Test.createTestingModule({
      controllers: [WebhookController],
      providers: [
        { provide: PIPELINE_TOKENS.RUN_AGGREGATE_FACTORY, useValue: factory },
        { provide: PIPELINE_TOKENS.RUN_REPOSITORY, useExisting: InMemoryRunRepository },
        { provide: InMemoryRunRepository, useValue: repo },
        { provide: IdentityService, useValue: identity },
      ],
    }).compile();
    controller = moduleRef.get(WebhookController);
  });

  function baseBody(overrides: Partial<GitWebhookBody> = {}): GitWebhookBody {
    return {
      event: 'push',
      repo: 'acme/platform',
      ref: 'refs/heads/main',
      actor: principalId,
      commit: 'deadbeefcafebabe',
      ...overrides,
    };
  }

  // ── D1-1 事件解析 ──

  it('parses a push event and creates a Run with status=pending', async () => {
    const res = await controller.webhookGit(baseBody());
    expect(res.received).toBe(true);
    expect(res.deduplicated).toBe(false);
    expect(res.status).toBe('pending');
    expect(res.runId).toMatch(/^run_/);
    expect(res.trigger).toEqual({
      event: 'push',
      repo: 'acme/platform',
      ref: 'refs/heads/main',
      actor: principalId,
      commit: 'deadbeefcafebabe',
    });
  });

  it('parses mr / tag / schedule events', async () => {
    const mr = await controller.webhookGit(
      baseBody({ event: 'mr', ref: 'feature/x', commit: 'c1' }),
    );
    expect(mr.trigger.event).toBe('mr');

    const tag = await controller.webhookGit(
      baseBody({ event: 'tag', ref: 'v1.2.3', commit: 'c2' }),
    );
    expect(tag.trigger.event).toBe('tag');

    // schedule 事件允许缺省 commit
    const sched = await controller.webhookGit(
      baseBody({ event: 'schedule', commit: undefined }),
    );
    expect(sched.trigger.event).toBe('schedule');
    expect(sched.trigger.commit).toBeUndefined();
  });

  it('derives pipelineId from repo when not provided', async () => {
    const res = await controller.webhookGit(baseBody({ repo: 'acme/platform.service' }));
    const loaded = await repo.load(res.runId);
    expect(loaded?.pipelineId).toBe('pipeline_acme_platform_service');
  });

  it('honors explicit pipelineId and tenantId in body', async () => {
    const res = await controller.webhookGit(
      baseBody({ pipelineId: 'pipeline-42', tenantId: 'tenant-explicit' }),
    );
    const loaded = await repo.load(res.runId);
    expect(loaded?.pipelineId).toBe('pipeline-42');
    expect(loaded?.tenantId).toBe('tenant-explicit');
  });

  // ── D1-2 落库 ──

  it('persists Run snapshot to repository (read-your-writes)', async () => {
    const res = await controller.webhookGit(baseBody());
    const loaded = await repo.load(res.runId);
    expect(loaded).not.toBeNull();
    expect(loaded?.runId).toBe(res.runId);
    expect(loaded?.status).toBe('pending');
    expect(loaded?.stage).toBe('trigger');
  });

  // ── D1-4 主体鉴权 ──

  it('rejects webhook with unregistered actor (401 Unauthorized)', async () => {
    await expect(
      controller.webhookGit(baseBody({ actor: 'unknown-principal' })),
    ).rejects.toThrow(/not a registered principal/);
  });

  it('uses principal tenantId when body omits tenantId', async () => {
    const res = await controller.webhookGit(baseBody());
    const loaded = await repo.load(res.runId);
    expect(loaded?.tenantId).toBe('tenant-1');
  });

  // ── 字段校验 ──

  it('rejects missing repo (422)', async () => {
    await expect(
      controller.webhookGit(baseBody({ repo: '' })),
    ).rejects.toThrow(/missing `repo`/);
  });

  it('rejects missing commit for push event (422)', async () => {
    await expect(
      controller.webhookGit(baseBody({ commit: '' })),
    ).rejects.toThrow(/missing `commit`/);
  });

  // ── D1-5 幂等去重 ──

  it('returns existing runId for duplicate webhook within dedup window', async () => {
    const first = await controller.webhookGit(baseBody());
    const second = await controller.webhookGit(baseBody());
    expect(second.runId).toBe(first.runId);
    expect(second.deduplicated).toBe(true);
    expect(second.status).toBe(first.status);
    // 仓储仅一份快照
    const tenantRuns = await repo.loadByTenant('tenant-1');
    expect(tenantRuns.filter((r) => r.runId === first.runId)).toHaveLength(1);
  });

  it('differentiates runs by commit (same repo/ref, new commit → new run)', async () => {
    const a = await controller.webhookGit(baseBody({ commit: 'aaa' }));
    const b = await controller.webhookGit(baseBody({ commit: 'bbb' }));
    expect(b.runId).not.toBe(a.runId);
    expect(b.deduplicated).toBe(false);
  });

  it('differentiates runs by event type for the same commit', async () => {
    const push = await controller.webhookGit(baseBody({ event: 'push' }));
    const tag = await controller.webhookGit(
      baseBody({ event: 'tag', ref: 'refs/tags/v1' }),
    );
    expect(tag.runId).not.toBe(push.runId);
  });
});
