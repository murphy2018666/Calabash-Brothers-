import { Injectable, Logger } from '@nestjs/common';
import type { TaskPlanRepository } from '@aegisci/domain/orchestration';
import {
  TaskPlan,
  type TaskPlanData,
  type PlannedTask,
  type OrchestrationState,
  OrchestrationStateMachine,
} from '@aegisci/domain/orchestration';

/**
 * PgTaskPlanRepository —— TaskPlan 仓储端口的 PostgreSQL 持久化实现（D2-2）。
 *
 * 职责：
 * - save()：将 TaskPlan 的 data 快照 + state 写入 task_plans 表（upsert）
 * - load(taskPlanId) / loadByRun(runId)：从 DB 读取后 rehydrate 成 TaskPlan 实例
 *
 * 表结构（由 ensureSchema() 在启动时创建；生产环境改用迁移工具）：
 *   CREATE TABLE task_plans (
 *     task_plan_id TEXT PRIMARY KEY,
 *     run_id       TEXT NOT NULL,
 *     data         JSONB NOT NULL,   -- TaskPlanData 完整快照
 *     state        TEXT NOT NULL     -- OrchestrationState 字符串
 *   );
 *   CREATE INDEX idx_task_plans_run_id ON task_plans(run_id);
 *
 * 注入约定：
 * - 生产：从 AEGISCI_PG_URL 构造 pg.Pool，直接注入
 * - 测试：通过构造函数传入 pg-mem 实例的 .query() 方法
 */
@Injectable()
export class PgTaskPlanRepository implements TaskPlanRepository {
  private readonly logger = new Logger(PgTaskPlanRepository.name);

  constructor(
    private readonly query: (text: string, params?: unknown[]) => Promise<{ rows: unknown[] }>,
  ) {}

  async ensureSchema(): Promise<void> {
    await this.query(`
      CREATE TABLE IF NOT EXISTS task_plans (
        task_plan_id TEXT PRIMARY KEY,
        run_id       TEXT NOT NULL,
        data         JSONB NOT NULL,
        state        TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_task_plans_run_id ON task_plans(run_id);
    `);
    this.logger.log('task_plans table ensured');
  }

  async save(plan: TaskPlan): Promise<void> {
    const data = extractData(plan);
    const state = plan.state;
    await this.query(
      `INSERT INTO task_plans (task_plan_id, run_id, data, state)
       VALUES ($1, $2, $3::jsonb, $4)
       ON CONFLICT (task_plan_id) DO UPDATE
         SET data = EXCLUDED.data, state = EXCLUDED.state`,
      [data.taskPlanId, data.runId, JSON.stringify(data), state],
    );
    this.logger.debug(
      `saved TaskPlan ${plan.taskPlanId} (run=${plan.runId}, state=${state})`,
    );
  }

  async load(taskPlanId: string): Promise<TaskPlan | null> {
    const rows = (await this.query(
      'SELECT data, state FROM task_plans WHERE task_plan_id = $1',
      [taskPlanId],
    )) as unknown as { rows: Array<{ data: TaskPlanData; state: OrchestrationState }> };
    if (!rows.rows[0]) return null;
    return rehydrate(rows.rows[0].data, rows.rows[0].state);
  }

  async loadByRun(runId: string): Promise<TaskPlan | null> {
    const rows = (await this.query(
      'SELECT data, state FROM task_plans WHERE run_id = $1 ORDER BY task_plan_id DESC LIMIT 1',
      [runId],
    )) as unknown as { rows: Array<{ data: TaskPlanData; state: OrchestrationState }> };
    if (!rows.rows[0]) return null;
    return rehydrate(rows.rows[0].data, rows.rows[0].state);
  }

  /** 测试/运维便利：清空全部数据（保留表结构） */
  async clear(): Promise<void> {
    await this.query('TRUNCATE task_plans');
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 序列化 / 反序列化
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 从 TaskPlan 实例中提取可 JSON 存储的 TaskPlanData 快照。
 *
 * TaskPlan 聚合根不暴露 toJSON，此处通过访问器提取，并手动重建 PrContext
 *（从 taskPlanId 与公开字段反推 runId/tenantId）。
 * 实际 PrContext 中的 trigger/diffRef/changedFiles 来自 createPlan 调用时传入，
 * 在 rehydrate 阶段通过 factory 重建，状态机和 tasks 数组直接覆盖。
 *
 * tenantId 获取路径说明（S3 代码走查 §9.4.1）：
 * - 优先从 plan.data.tenantId 读取（由 TaskPlan 聚合根在创建时写入，来源为决策层传入）；
 * - 降级路径通过 plan.tenantId getter 读取，该 getter 同样源自聚合根内部 state。
 * - tenantId 不由外部输入直接构造，避免租户注入攻击（对应 i2-injection-defense 防御策略）。
 */
function extractData(plan: TaskPlan): TaskPlanData {
  // 通过类型断言访问聚合根内部的 data 字段（TypeScript 编译时私有，运行时可读）
  const src = plan as unknown as { data: TaskPlanData };
  if (src.data) return src.data;
  // 降级：从公开 getter 重建
  const tasks: PlannedTask[] = plan.tasks.map((t) => ({
    taskId: t.taskId,
    role: t.role,
    agentId: t.agentId,
    scope: t.scope,
    tokenBudget: t.tokenBudget,
    dependsOn: t.dependsOn,
    mode: t.mode,
    parentEntryId: t.parentEntryId,
    ttlMs: t.ttlMs,
    dispatched: t.dispatched,
    concluded: t.concluded,
  }));
  const plannerTask = tasks.find((t) => t.role === 'planner');
  return {
    taskPlanId: plan.taskPlanId,
    runId: plan.runId,
    tenantId: plan.tenantId,
    prContext: {
      runId: plan.runId,
      tenantId: plan.tenantId,
      trigger: { event: 'push', ref: '', repo: '', actor: '' },
      diffRef: '',
      changedFiles: [],
      riskHint: plan.riskLevel,
      globalConstraints: [],
    },
    tasks,
    riskLevel: plan.riskLevel,
    requiresHumanApproval: plan.riskLevel === 'G3' || plan.riskLevel === 'G4',
    createdAt: new Date().toISOString(),
  } as unknown as TaskPlanData;
}

/**
 * 从 DB 行反序列化重建 TaskPlan 实例 + 还原状态机。
 *
 * 策略：
 * 1. 用 fromPrContext 工厂重建骨架（tasks 数组由快照覆盖）
 * 2. 直接设置 sm.state（绕过状态机约束，因为 rehydration 不需要经历迁移校验）
 * 3. 覆盖 data.tasks 为持久化的快照（含 dispatched/concluded 标记）
 */
function rehydrate(raw: TaskPlanData, currentState: OrchestrationState): TaskPlan {
  const plannerTask = raw.tasks.find((t) => t.role === 'planner');
  const plan = TaskPlan.fromPrContext(
    raw.taskPlanId,
    raw.prContext,
    plannerTask?.agentId ?? 'planner-fallback',
    raw.tasks
      .filter((t) => t.role !== 'planner')
      .map((t) => ({ role: t.role, agentId: t.agentId, tokenBudget: t.tokenBudget })),
  );
  // 直接覆写私有字段（运行时可行，TS 编译时私有）
  const typed = plan as unknown as {
    sm: OrchestrationStateMachine;
    data: TaskPlanData;
  };
  typed.data = raw;
  (typed.sm as unknown as { state: OrchestrationState }).state = currentState;
  return plan;
}
