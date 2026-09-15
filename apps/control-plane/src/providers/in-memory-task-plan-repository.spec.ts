import type { RunTrigger } from '@aegisci/shared/types';
import { TASK_PLAN_REPOSITORY, type TaskPlanRepository, type PrContext } from '@aegisci/domain/orchestration';
import { TaskPlan } from '@aegisci/domain/orchestration';
import { InMemoryTaskPlanRepository } from './in-memory-task-plan-repository';

/**
 * InMemoryTaskPlanRepository 单元测试（D2-2 持久化仓储端口实现）。
 *
 * 覆盖端口契约不变在：
 * - read-your-writes：save() 后 load() 必命中
 * - loadByRun() 按 runId 查询命中
 * - 空结果返回 null
 * - 重复 save 为 upsert
 * - clear() 清空全部状态
 */
describe('InMemoryTaskPlanRepository (D2-2 持久化端口实现)', () => {
  let repo: InMemoryTaskPlanRepository;

  beforeEach(() => {
    repo = new InMemoryTaskPlanRepository();
  });

  // ── save / load ──

  it('loads the saved plan immediately (read-your-writes)', async () => {
    const plan = makePlan('tp-1', 'run-1');
    await repo.save(plan);
    const loaded = await repo.load('tp-1');
    expect(loaded).not.toBeNull();
    expect(loaded?.taskPlanId).toBe('tp-1');
    expect(loaded?.runId).toBe('run-1');
  });

  it('returns null for an unknown taskPlanId', async () => {
    expect(await repo.load('nonexistent')).toBeNull();
  });

  it('upserts on repeated save with same id', async () => {
    await repo.save(makePlan('tp-1', 'run-1'));
    await repo.save(makePlan('tp-1', 'run-1', 'dispatching'));
    const loaded = await repo.load('tp-1');
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
    repo.clear();
    expect(await repo.load('tp-1')).toBeNull();
    expect(await repo.loadByRun('run-1')).toBeNull();
  });

  // ── DI token wiring ──

  it('is injectable via TASK_PLAN_REPOSITORY token', async () => {
    // 用 DI 令牌验证类型一致性：实现类可强转赋值给接口
    const asRepo: TaskPlanRepository = repo;
    expect(asRepo.save).toBeDefined();
    expect(asRepo.load).toBeDefined();
    expect(asRepo.loadByRun).toBeDefined();
    // 实际 DI 绑定由 SpiDefaultsModule 负责（useExisting 模式）
    expect(TASK_PLAN_REPOSITORY).toBeDefined();
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
