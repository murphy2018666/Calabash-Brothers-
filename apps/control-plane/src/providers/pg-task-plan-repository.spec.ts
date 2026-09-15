import type { RunTrigger } from '@aegisci/shared/types';
import { TaskPlan, type PrContext, type TaskPlanRepository } from '@aegisci/domain/orchestration';
import { PgTaskPlanRepository } from './pg-task-plan-repository';

/**
 * PgTaskPlanRepository 单元测试（D2-2 PG 持久化）。
 *
 * 使用 pg-mem 提供内存中的 PostgreSQL（无需外部 PG 服务），
 * 验证端口契约不变在：
 * - read-your-writes：save() 后 load() 必命中
 * - loadByRun() 按 runId 查询命中，且返回最新的 plan
 * - null for unknown
 * - upsert：重复 save 覆盖快照（含状态推进）
 * - DI token
 */
describe('PgTaskPlanRepository (D2-2 PG 持久化)', () => {
  let repo: PgTaskPlanRepository;
  let pool: { query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };

  beforeEach(async () => {
    const { newDb } = await import('pg-mem');
    const mem = newDb();
    const pg = mem.adapters.createPg();
    pool = new pg.Pool();
    repo = new PgTaskPlanRepository((text: string, params?: unknown[]) =>
      pool.query(text, params),
    );
    await repo.ensureSchema();
  });

  afterEach(async () => {
    await pool.query('SELECT 1'); // no-op to keep alive
  });

  // ── save / load ──

  it('loads the saved plan immediately (read-your-writes)', async () => {
    const plan = makePlan('tp-1', 'run-1');
    await repo.save(plan);
    const loaded = await repo.load('tp-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.taskPlanId).toBe('tp-1');
    expect(loaded?.runId).toBe('run-1');
    expect(loaded?.state).toBe('Planning');
  });

  it('returns null for an unknown taskPlanId', async () => {
    expect(await repo.load('nonexistent')).toBeNull();
  });

  it('upserts on repeated save with same id', async () => {
    await repo.save(makePlan('tp-1', 'run-1'));
    await repo.save(makePlan('tp-1', 'run-1', 'dispatching'));
    const loaded = await repo.load('tp-1');
    expect(loaded).not.toBeNull();
    // dispatchNext 在 planner 派发后自动推进到 AwaitingAgents
    expect(loaded?.state).toBe('AwaitingAgents');
  });

  // ── loadByRun() ──

  it('returns the latest plan matching the runId', async () => {
    await repo.save(makePlan('tp-a', 'run-x', 'planning'));
    await repo.save(makePlan('tp-b', 'run-x', 'dispatching'));
    const loaded = await repo.loadByRun('run-x');
    expect(loaded).not.toBeNull();
    expect(loaded?.taskPlanId).toBe('tp-b');
    // dispatchNext 在 planner 派发后自动推进到 AwaitingAgents
    expect(loaded?.state).toBe('AwaitingAgents');
  });

  it('returns null for a runId with no plans', async () => {
    expect(await repo.loadByRun('run-empty')).toBeNull();
  });

  // ── clear() ──

  it('empties all stored plans (restart simulation)', async () => {
    await repo.save(makePlan('tp-1', 'run-1'));
    await repo.clear();
    expect(await repo.load('tp-1')).toBeNull();
    expect(await repo.loadByRun('run-1')).toBeNull();
  });

  // ── DI token wiring ──

  it('is injectable via TASK_PLAN_REPOSITORY token (interface contract)', async () => {
    const asRepo: TaskPlanRepository = repo;
    expect(asRepo.save).toBeDefined();
    expect(asRepo.load).toBeDefined();
    expect(asRepo.loadByRun).toBeDefined();
  });

  // ── rehydration 保真度 ──

  it('preserves task dispatched/concluded flags after rehydration', async () => {
    const plan = makePlan('tp-h', 'run-h', 'dispatching');
    await repo.save(plan);

    const loaded = await repo.load('tp-h');
    expect(loaded).not.toBeNull();
    // planner 任务应已 dispatched
    const plannerTask = loaded?.tasks.find((t) => t.role === 'planner');
    expect(plannerTask?.dispatched).toBe(true);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 辅助函数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function makePlan(
  taskPlanId: string,
  runId: string,
  state: 'planning' | 'dispatching' | 'done' = 'planning',
): TaskPlan {
  const trigger: RunTrigger = {
    event: 'push',
    ref: `ref-${runId}`,
    repo: 'acme/x',
    actor: 'bot',
    commit: 'c1',
  };
  const ctx: PrContext = {
    runId,
    tenantId: 'tenant-default',
    trigger,
    diffRef: trigger.ref,
    changedFiles: ['src/main.ts'],
    riskHint: 'G2',
    globalConstraints: [],
  };
  const plan = TaskPlan.fromPrContext(taskPlanId, ctx, `planner-${runId}`, []);
  if (state === 'dispatching') {
    plan.approve('PlanAutoLowRisk');
    plan.dispatchNext(
      { blackboardSessionId: 'bbs-default', runId, entries: [], takenAt: new Date().toISOString() },
      (payload) => ({
        eventId: `evt_${plan.taskPlanId}`,
        eventType: 'or.task.dispatched',
        aggregateId: plan.taskPlanId,
        aggregateType: 'TaskPlan',
        tenantId: ctx.tenantId,
        payload,
        timestamp: new Date().toISOString(),
        traceId: runId,
        spanId: `span_${Date.now()}`,
      }),
    );
  }
  return plan;
}
