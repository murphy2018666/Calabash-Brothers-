import type { Run } from '@aegisci/shared/types';
import {
  RunAggregate,
  RUN_WRITER,
  RunStateMachine,
  RunStageWriteViolationError,
  IllegalRunTransitionError,
  RunAlreadyTerminalError,
  type PipelineEventContext,
  type RunRepositoryPort,
} from './index';

/**
 * Run 状态机持久化集成测试（D1-3）。
 *
 * 验证不变量：
 * - 所有 RunAggregate mutate 均经 RunStateMachine.transition() 守卫，写者恒为 'PL'
 * - 非 PL 写者（如 'OR'）触发 RunStageWriteViolationError（铁律 1）
 * - 非法迁移触发 IllegalRunTransitionError；终态后 mutate 触发 RunAlreadyTerminalError
 * - 模拟控制面重启：save → 重建 rehydrate → 继续推进，in-progress Run 状态可恢复
 * - Run 状态变更经仓储持久化（read-your-writes）
 */
describe('RunStateMachine persistence (D1-3)', () => {
  const ctx: PipelineEventContext = {
    nextEventId: () => `evt_${Math.random().toString(36).slice(2)}`,
    now: () => new Date().toISOString(),
    traceId: 'persist-test-trace',
    spanId: 'persist-test-span',
  };
  let sm: RunStateMachine;

  beforeEach(() => {
    sm = new RunStateMachine();
  });

  /** 极简 RunRepositoryPort 实现（内存 Map，模拟持久化） */
  function createFakeRepo(): RunRepositoryPort {
    const store = new Map<string, Run>();
    return {
      async load(runId: string) {
        const hit = store.get(runId);
        return hit ? { ...hit } : null;
      },
      async save(snapshot: Run) {
        store.set(snapshot.runId, { ...snapshot });
      },
    };
  }

  function newRun(runId = 'run_persist_1'): RunAggregate {
    return RunAggregate.create(
      {
        runId,
        tenantId: 'tenant-1',
        pipelineId: 'pipeline-1',
        stage: 'trigger',
        trigger: {
          event: 'push',
          repo: 'acme/x',
          ref: 'main',
          actor: 'bot',
          commit: 'c1',
        },
      },
      sm,
      ctx,
    );
  }

  // ── 铁律 1：写者守卫 ──

  it('allows PL writer to advance stage and transition status', () => {
    const run = newRun();
    expect(run.status).toBe('pending');
    expect(run.stage).toBe('trigger');

    // PL 唯一写者推进 stage（铁律 1）
    run.advanceStage('review', RUN_WRITER);
    expect(run.stage).toBe('review');

    run.startPlanning(RUN_WRITER);
    expect(run.status).toBe('planning');
  });

  it('rejects non-PL writer on stage advance (铁律 1)', () => {
    const run = newRun();
    expect(() => run.advanceStage('review', 'OR')).toThrow(
      RunStageWriteViolationError,
    );
  });

  it('rejects non-PL writer on status transition', () => {
    const run = newRun();
    expect(() => run.startPlanning('OR')).toThrow(RunStageWriteViolationError);
    expect(() => run.startPlanning('agent')).toThrow(RunStageWriteViolationError);
    // 状态未变
    expect(run.status).toBe('pending');
  });

  // ── 状态机迁移校验 ──

  it('rejects illegal transition (pending → completed)', () => {
    const run = newRun();
    expect(() => run.complete(RUN_WRITER)).toThrow(IllegalRunTransitionError);
  });

  it('rejects mutate after terminal state', () => {
    const run = newRun();
    run.cancel(RUN_WRITER); // pending → cancelled (终态)
    expect(() => run.startPlanning(RUN_WRITER)).toThrow(RunAlreadyTerminalError);
  });

  // ── D1-3：持久化 + 重启模拟 ──

  it('persists status changes through repository (read-your-writes)', async () => {
    const repo = createFakeRepo();
    const run = newRun();
    // 初始快照落库
    await repo.save(run.snapshot);
    expect((await repo.load(run.runId))?.status).toBe('pending');

    // 推进状态并落库
    run.startPlanning(RUN_WRITER);
    await repo.save(run.snapshot);
    expect((await repo.load(run.runId))?.status).toBe('planning');
  });

  it('simulates control-plane restart: rehydrate preserves in-progress run', async () => {
    const repo = createFakeRepo();

    // 第一次"进程"：创建 + 推进到 reviewing
    const run1 = newRun('run_restart');
    run1.startPlanning(RUN_WRITER);
    run1.startDispatching(RUN_WRITER);
    run1.startReviewing(RUN_WRITER);
    await repo.save(run1.snapshot);
    expect(run1.status).toBe('reviewing');

    // 模拟重启：丢弃内存中的聚合根，从仓储快照重建
    const snapshot = await repo.load('run_restart');
    expect(snapshot).not.toBeNull();
    const revived = RunAggregate.rehydrate(snapshot!, sm, ctx);
    expect(revived.status).toBe('reviewing');
    expect(revived.stage).toBe('trigger');

    // 重启后继续推进（PL 写者），状态变更可再次落库
    revived.passGate(RUN_WRITER);
    expect(revived.status).toBe('gate_passed');
    await repo.save(revived.snapshot);
    expect((await repo.load('run_restart'))?.status).toBe('gate_passed');
  });

  it('terminal run cannot be revived into a new transition', async () => {
    const repo = createFakeRepo();
    const run = newRun('run_terminal');
    run.fail(RUN_WRITER, 'boom');
    await repo.save(run.snapshot);

    const revived = RunAggregate.rehydrate(
      (await repo.load('run_terminal'))!,
      sm,
      ctx,
    );
    expect(revived.status).toBe('failed');
    // 终态后任何推进均被状态机阻断
    expect(() => revived.startPlanning(RUN_WRITER)).toThrow(
      RunAlreadyTerminalError,
    );
  });

  // ── 事件收集（Unit of Work） ──

  it('records uncommitted events on each mutate and clears after commit', () => {
    const run = newRun();
    expect(run.uncommittedEvents).toHaveLength(1); // RunCreated

    run.startPlanning(RUN_WRITER);
    expect(run.uncommittedEvents.length).toBeGreaterThan(1);

    run.markEventsCommitted();
    expect(run.uncommittedEvents).toHaveLength(0);
  });
});
