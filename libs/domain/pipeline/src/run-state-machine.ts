/**
 * PL 域 Run 状态机守卫
 *
 * 对应设计文档：
 * - ADD §3.2 跨域三条铁律 1：Run.stage 唯一写者是 PL
 * - DES-3 PL 限界上下文：Run 生命周期唯一写者
 * - DES-4 §4.2 双状态机唯一写者规则（OR 不得直接改 PL 聚合根）
 *
 * 职责：
 * 1. 写者守卫：断言只有 PL 可以写 Run.stage / Run.status。
 *    任何 OR/PO 想推进状态，只能发领域事件由 PL 订阅推进或拒绝推进。
 * 2. 状态迁移校验：禁止非法跳转，违反即抛 IllegalRunTransitionError
 *    （CI 守护测试将捕获，违反铁律即构建失败）。
 *
 * 状态机：
 *   pending → planning → dispatching → reviewing
 *          ↘                             ↓
 *       (任意活跃态) → gate_blocked → gate_passed → deploying → completed
 *          ↘↘↘                ↓                 ↓          ↓
 *        failed/cancelled   failed/cancelled   ...    (终态)
 *   终态：completed / failed / cancelled（无后继迁移）
 */
import { Injectable } from '@nestjs/common';
import type { RunStatus } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 写者常量
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Run.stage / Run.status 的唯一合法写者标识。
 * 铁律 1：OR/PO 不得直接写 run.stage；仅能发布领域事件。
 */
export const RUN_WRITER = 'PL' as const;
export type RunWriter = typeof RUN_WRITER;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 合法迁移表
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * Run.status 合法迁移表。
 * 任意"活跃态"均可迁移到 failed / cancelled（终态）。
 * completed / failed / cancelled 为终态，无后继。
 */
export const RUN_STATE_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = {
  pending: ['planning', 'failed', 'cancelled'],
  planning: ['dispatching', 'failed', 'cancelled'],
  dispatching: ['reviewing', 'failed', 'cancelled'],
  reviewing: ['gate_blocked', 'gate_passed', 'failed', 'cancelled'],
  gate_blocked: ['gate_passed', 'failed', 'cancelled'],
  gate_passed: ['deploying', 'failed', 'cancelled'],
  deploying: ['completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/** 活跃态集合（可被 fail/cancel） */
export const RUN_ACTIVE_STATES: readonly RunStatus[] = [
  'pending',
  'planning',
  'dispatching',
  'reviewing',
  'gate_blocked',
  'gate_passed',
  'deploying',
];

/** 终态集合 */
export const RUN_TERMINAL_STATES: readonly RunStatus[] = [
  'completed',
  'failed',
  'cancelled',
];

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 错误类型
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 写者越权错误（违反铁律 1）。
 * CI 守护测试应断言：OR/PO 调用任何 mutate 方法即抛此异常。
 */
export class RunStageWriteViolationError extends Error {
  constructor(
    public readonly writer: string,
    public readonly runId: string,
    message = `Run.stage write violation: only '${RUN_WRITER}' may write Run.stage/status, got '${writer}'`,
  ) {
    super(message);
    this.name = 'RunStageWriteViolationError';
  }
}

/** 非法状态迁移错误（违反状态机不变量） */
export class IllegalRunTransitionError extends Error {
  constructor(
    public readonly from: RunStatus,
    public readonly to: RunStatus,
    public readonly runId: string,
    message?: string,
  ) {
    super(
      message ??
        `Illegal Run transition: ${from} -> ${to} (run ${runId})`,
    );
    this.name = 'IllegalRunTransitionError';
  }
}

/** Run 已处于终态，不可再迁移 */
export class RunAlreadyTerminalError extends Error {
  constructor(
    public readonly status: RunStatus,
    public readonly runId: string,
  ) {
    super(`Run ${runId} already terminal: ${status}`);
    this.name = 'RunAlreadyTerminalError';
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 状态机服务
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * RunStateMachine —— 无状态可注入服务。
 * 由 PL.Application 在每次聚合根 mutate 前调用，确保写者与迁移合法。
 *
 * 作为 @Injectable() 提供，使控制面启动时可被 InvariantGuard 织入校验链路
 * （ADD §10 AG-1 架构守护套件）。
 */
@Injectable()
export class RunStateMachine {
  /**
   * 写者守卫：断言调用者是 PL。
   * @throws RunStageWriteViolationError 当 writer !== 'PL'
   */
  assertWriter(writer: string, runId: string): asserts writer is RunWriter {
    if (writer !== RUN_WRITER) {
      throw new RunStageWriteViolationError(writer, runId);
    }
  }

  /** 是否允许 from → to 迁移 */
  canTransition(from: RunStatus, to: RunStatus): boolean {
    if (from === to) return false;
    return RUN_STATE_TRANSITIONS[from]?.includes(to) ?? false;
  }

  /** 是否终态 */
  isTerminal(status: RunStatus): boolean {
    return (RUN_TERMINAL_STATES as readonly string[]).includes(status);
  }

  /**
   * 校验迁移合法性。
   * @throws RunAlreadyTerminalError 当 from 已终态
   * @throws IllegalRunTransitionError 当 from→to 不在迁移表
   */
  assertTransition(from: RunStatus, to: RunStatus, runId: string): void {
    if (this.isTerminal(from)) {
      throw new RunAlreadyTerminalError(from, runId);
    }
    if (!this.canTransition(from, to)) {
      throw new IllegalRunTransitionError(from, to, runId);
    }
  }

  /**
   * 校验并执行迁移，返回新状态。
   * 写者守卫 + 迁移校验一并完成，供聚合根 mutate 路径调用。
   */
  transition(
    from: RunStatus,
    to: RunStatus,
    writer: string,
    runId: string,
  ): RunStatus {
    this.assertWriter(writer, runId);
    this.assertTransition(from, to, runId);
    return to;
  }
}
