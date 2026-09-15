/**
 * E8-1: ValueStreamViewService 单元测试
 *
 * 覆盖：
 * - 价值流视图生成
 * - 运行详情查询
 * - 阶段判定逻辑
 * - 进度计算
 * - 统计摘要
 * - 空数据集处理
 * - 门禁/审批关联
 */
import { Test } from '@nestjs/testing';
import { ValueStreamViewService, type ValueStreamRepositories, type ValueStreamEntry } from './value-stream-view.service';
import type { TaskPlan } from '@aegisci/domain/orchestration';
import type { GateRecord } from '@aegisci/domain/pipeline';
import type { ApprovalTicketSnapshot } from './in-memory-approval-repository';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试数据工厂
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function makeTaskPlan(overrides: Partial<TaskPlan> = {}): TaskPlan {
  return {
    taskPlanId: `tp_${Math.random().toString(36).slice(2)}`,
    runId: 'run-001',
    tenantId: 'tenant-001',
    pipelineTitle: 'CI/CD Pipeline',
    state: 'planned',
    stage: 'plan',
    triggerSource: 'pr',
    prRef: 'refs/pull/123/head',
    initiator: 'user-alice',
    riskLevel: 'G2',
    createdAt: '2026-09-08T10:00:00.000Z',
    updatedAt: '2026-09-08T10:05:00.000Z',
    estimatedCompletion: '2026-09-08T11:00:00.000Z',
    ...overrides,
  } as TaskPlan;
}

function makeGateRecord(overrides: Partial<GateRecord> = {}): GateRecord {
  return {
    gateId: `gate_${Math.random().toString(36).slice(2)}`,
    runId: 'run-001',
    tenantId: 'tenant-001',
    stageIndex: 0,
    riskTier: 'G2',
    state: 'blocked',
    decision: 'hitl',
    blockedBy: 'user-bob',
    createdAt: '2026-09-08T10:02:00.000Z',
    updatedAt: '2026-09-08T10:02:00.000Z',
    ...overrides,
  } as GateRecord;
}

function makeApprovalTicket(overrides: Partial<ApprovalTicketSnapshot> = {}): ApprovalTicketSnapshot {
  return {
    ticketId: `ticket_${Math.random().toString(36).slice(2)}`,
    evidenceId: 'run-001_evt_001',
    tenantId: 'tenant-001',
    requiredQuorum: 2,
    state: 'open',
    votes: [],
    createdAt: '2026-09-08T10:02:00.000Z',
    ...overrides,
  } as ApprovalTicketSnapshot;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 内存仓库实现
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class InMemoryTaskPlanRepo {
  private readonly store = new Map<string, TaskPlan>();

  async loadByRun(runId: string): Promise<TaskPlan | null> {
    for (const plan of this.store.values()) {
      if (plan.runId === runId) return plan;
    }
    return null;
  }

  async listAll(): Promise<TaskPlan[]> {
    return Array.from(this.store.values());
  }

  add(plan: TaskPlan): void {
    this.store.set(plan.taskPlanId, plan);
  }

  clear(): void {
    this.store.clear();
  }
}

class InMemoryGateRepo {
  private readonly byRun = new Map<string, GateRecord[]>();

  async load(gateId: string): Promise<GateRecord | null> {
    for (const records of this.byRun.values()) {
      const found = records.find((g) => g.gateId === gateId);
      if (found) return found;
    }
    return null;
  }

  async listByRun(runId: string): Promise<GateRecord[]> {
    return this.byRun.get(runId) ?? [];
  }

  add(runId: string, gate: GateRecord): void {
    if (!this.byRun.has(runId)) {
      this.byRun.set(runId, []);
    }
    this.byRun.get(runId)!.push(gate);
  }

  clear(): void {
    this.byRun.clear();
  }
}

class InMemoryApprovalRepo {
  private readonly tickets: ApprovalTicketSnapshot[] = [];

  async load(ticketId: string): Promise<ApprovalTicketSnapshot | null> {
    return this.tickets.find((t) => t.ticketId === ticketId) ?? null;
  }

  async listOpen(_tenantId: string): Promise<ApprovalTicketSnapshot[]> {
    return this.tickets.filter((t) => t.state === 'open');
  }

  add(ticket: ApprovalTicketSnapshot): void {
    this.tickets.push(ticket);
  }

  clear(): void {
    this.tickets.length = 0;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('E8-1 ValueStreamViewService', () => {
  let service: ValueStreamViewService;
  let taskPlanRepo: InMemoryTaskPlanRepo;
  let gateRepo: InMemoryGateRepo;
  let approvalRepo: InMemoryApprovalRepo;
  let repos: ValueStreamRepositories;

  beforeEach(async () => {
    taskPlanRepo = new InMemoryTaskPlanRepo();
    gateRepo = new InMemoryGateRepo();
    approvalRepo = new InMemoryApprovalRepo();

    repos = {
      taskPlanRepo,
      gateRepo,
      approvalRepo,
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ValueStreamViewService,
        { provide: 'ValueStreamRepositories', useValue: repos },
      ],
    }).compile();

    service = moduleRef.get<ValueStreamViewService>(ValueStreamViewService);
  });

  afterEach(() => {
    taskPlanRepo.clear();
    gateRepo.clear();
    approvalRepo.clear();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 基础视图生成
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E8-1-1: generates view with active and completed runs', async () => {
    // 活跃运行
    taskPlanRepo.add(makeTaskPlan({ state: 'testing', runId: 'run-001' }));
    // 已完成运行
    taskPlanRepo.add(makeTaskPlan({ state: 'verified', runId: 'run-002', createdAt: '2026-09-07T10:00:00.000Z' }));
    taskPlanRepo.add(makeTaskPlan({ state: 'failed', runId: 'run-003', createdAt: '2026-09-07T11:00:00.000Z' }));

    const view = await service.getView('tenant-001', '2026-09-07T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

    expect(view.activeRuns.length).toBe(1);
    expect(view.completedRuns.length).toBe(2);
    expect(view.summary.totalRuns).toBe(3);
    expect(view.summary.activeCount).toBe(1);
    expect(view.summary.completedCount).toBe(2);
  });

  it('E8-1-2: filters by tenant', async () => {
    taskPlanRepo.add(makeTaskPlan({ tenantId: 'tenant-001', runId: 'run-001' }));
    taskPlanRepo.add(makeTaskPlan({ tenantId: 'tenant-002', runId: 'run-002' }));

    const view = await service.getView('tenant-001', '2026-09-07T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

    expect(view.summary.totalRuns).toBe(1);
    expect(view.activeRuns.every((r) => r.tenantId === 'tenant-001')).toBe(true);
  });

  it('E8-1-3: filters by time range', async () => {
    taskPlanRepo.add(makeTaskPlan({ runId: 'run-001', createdAt: '2026-09-07T10:00:00.000Z' }));
    taskPlanRepo.add(makeTaskPlan({ runId: 'run-002', createdAt: '2026-09-08T10:00:00.000Z' }));

    const view = await service.getView('tenant-001', '2026-09-08T00:00:00.000Z', '2026-09-08T23:59:59.999Z');

    expect(view.summary.totalRuns).toBe(1);
    expect(view.activeRuns[0].runId).toBe('run-002');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 阶段判定
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E8-1-4: determines stage from plan state', async () => {
    const plan = makeTaskPlan({ state: 'deploying', runId: 'run-001' });
    taskPlanRepo.add(plan);

    const entry = await service.getRunView('tenant-001', 'run-001');

    expect(entry?.currentStage).toBe('deploying');
  });

  it('E8-1-5: blocked gate overrides plan state', async () => {
    const plan = makeTaskPlan({ state: 'testing', runId: 'run-001' });
    const gate = makeGateRecord({ runId: 'run-001', state: 'blocked' });
    taskPlanRepo.add(plan);
    gateRepo.add('run-001', gate);

    const entry = await service.getRunView('tenant-001', 'run-001');

    expect(entry?.currentStage).toBe('blocked');
    expect(entry?.blockReason).toBe('user-bob'); // blockedBy 字段
  });

  it('E8-1-6: open approval sets stage to approved', async () => {
    const plan = makeTaskPlan({ state: 'testing', runId: 'run-001' });
    const approval = makeApprovalTicket({ evidenceId: 'run-001_evt_001' });
    taskPlanRepo.add(plan);
    approvalRepo.add(approval);

    const entry = await service.getRunView('tenant-001', 'run-001');

    expect(entry?.currentStage).toBe('approved');
    expect(entry?.approvalInfo).toBeDefined();
    expect(entry?.approvalInfo?.state).toBe('open');
  });

  it('E8-1-7: verified run marked as completed', async () => {
    taskPlanRepo.add(makeTaskPlan({ state: 'verified', runId: 'run-001', createdAt: '2026-09-07T10:00:00.000Z' }));

    const view = await service.getView('tenant-001', '2026-09-07T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

    expect(view.completedRuns.some((r) => r.currentStage === 'verified')).toBe(true);
  });

  it('E8-1-8: failed run marked as completed with failed stage', async () => {
    taskPlanRepo.add(makeTaskPlan({ state: 'failed', runId: 'run-001', createdAt: '2026-09-07T10:00:00.000Z' }));

    const view = await service.getView('tenant-001', '2026-09-07T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

    expect(view.completedRuns.some((r) => r.currentStage === 'failed')).toBe(true);
    expect(view.summary.failedCount).toBe(1);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 进度计算
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E8-1-9: calculates progress based on stage', async () => {
    const plan = makeTaskPlan({ state: 'testing', runId: 'run-001' });
    taskPlanRepo.add(plan);

    const entry = await service.getRunView('tenant-001', 'run-001');

    expect(entry?.progress).toBe(0.4);
  });

  it('E8-1-10: blocked gate reduces progress', async () => {
    const plan = makeTaskPlan({ state: 'testing', runId: 'run-001' });
    const gate = makeGateRecord({ runId: 'run-001', state: 'blocked' });
    taskPlanRepo.add(plan);
    gateRepo.add('run-001', gate);

    const entry = await service.getRunView('tenant-001', 'run-001');

    expect(entry?.progress).toBe(0.65);
  });

  it('E8-1-11: verified run has progress 1.0', async () => {
    taskPlanRepo.add(makeTaskPlan({ state: 'verified', runId: 'run-001' }));

    const entry = await service.getRunView('tenant-001', 'run-001');

    expect(entry?.progress).toBe(1.0);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 统计摘要
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E8-1-12: calculates success rate', async () => {
    taskPlanRepo.add(makeTaskPlan({ state: 'verified', runId: 'run-001', createdAt: '2026-09-07T10:00:00.000Z' }));
    taskPlanRepo.add(makeTaskPlan({ state: 'verified', runId: 'run-002', createdAt: '2026-09-07T11:00:00.000Z' }));
    taskPlanRepo.add(makeTaskPlan({ state: 'failed', runId: 'run-003', createdAt: '2026-09-07T12:00:00.000Z' }));

    const view = await service.getView('tenant-001', '2026-09-07T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

    expect(view.summary.successRate).toBe(67); // 2/3 ≈ 67%
  });

  it('E8-1-13: calculates blocked count', async () => {
    const plan1 = makeTaskPlan({ state: 'testing', runId: 'run-001' });
    const plan2 = makeTaskPlan({ state: 'testing', runId: 'run-002' });
    const gate1 = makeGateRecord({ runId: 'run-001', state: 'blocked' });
    taskPlanRepo.add(plan1);
    taskPlanRepo.add(plan2);
    gateRepo.add('run-001', gate1);

    const view = await service.getView('tenant-001', '2026-09-08T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

    expect(view.summary.blockedCount).toBe(1);
    expect(view.activeRuns.length).toBe(2);
  });

  it('E8-1-14: avg duration calculation', async () => {
    // run-001: 5 minutes
    taskPlanRepo.add(makeTaskPlan({
      state: 'verified',
      runId: 'run-001',
      createdAt: '2026-09-07T10:00:00.000Z',
      updatedAt: '2026-09-07T10:05:00.000Z',
    }));
    // run-002: 10 minutes
    taskPlanRepo.add(makeTaskPlan({
      state: 'verified',
      runId: 'run-002',
      createdAt: '2026-09-07T11:00:00.000Z',
      updatedAt: '2026-09-07T11:10:00.000Z',
    }));

    const view = await service.getView('tenant-001', '2026-09-07T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

    expect(view.summary.avgDurationMs).toBeGreaterThan(0);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 边界条件
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E8-1-15: handles empty dataset', async () => {
    const view = await service.getView('tenant-001', '2026-09-08T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

    expect(view.activeRuns).toEqual([]);
    expect(view.completedRuns).toEqual([]);
    expect(view.summary.totalRuns).toBe(0);
    expect(view.summary.successRate).toBe(0);
  });

  it('E8-1-16: returns null for non-existent run', async () => {
    const entry = await service.getRunView('tenant-001', 'run-nonexistent');
    expect(entry).toBeNull();
  });

  it('E8-1-17: returns null for run in different tenant', async () => {
    taskPlanRepo.add(makeTaskPlan({ tenantId: 'tenant-002', runId: 'run-001' }));

    const entry = await service.getRunView('tenant-001', 'run-001');
    expect(entry).toBeNull();
  });

  it('E8-1-18: entry includes PR reference', async () => {
    taskPlanRepo.add(makeTaskPlan({
      runId: 'run-001',
      prRef: 'refs/pull/123/head',
      triggerSource: 'pr',
    }));

    const entry = await service.getRunView('tenant-001', 'run-001');

    expect(entry?.prRef).toBe('refs/pull/123/head');
    expect(entry?.triggerSource).toBe('pr');
  });

  it('E8-1-19: entry includes risk level', async () => {
    taskPlanRepo.add(makeTaskPlan({ runId: 'run-001', riskLevel: 'G4' }));

    const entry = await service.getRunView('tenant-001', 'run-001');

    expect(entry?.riskLevel).toBe('G4');
  });

  it('E8-1-20: completed runs limited to 20', async () => {
    for (let i = 1; i <= 25; i++) {
      taskPlanRepo.add(makeTaskPlan({
        state: 'verified',
        runId: `run-${i.toString().padStart(3, '0')}`,
        createdAt: '2026-09-07T10:00:00.000Z',
      }));
    }

    const view = await service.getView('tenant-001', '2026-09-07T00:00:00.000Z', '2026-09-09T00:00:00.000Z');

    expect(view.completedRuns.length).toBeLessThanOrEqual(20);
  });

  it('E8-1-21: includes approval info when present', async () => {
    const plan = makeTaskPlan({ state: 'testing', runId: 'run-001' });
    const approval = makeApprovalTicket({
      evidenceId: 'run-001_evt_001',
      requiredQuorum: 2,
      votes: [{ voterId: 'user-bob', votedAt: '2026-09-08T10:03:00.000Z' }],
    });
    taskPlanRepo.add(plan);
    approvalRepo.add(approval);

    const entry = await service.getRunView('tenant-001', 'run-001');

    expect(entry?.approvalInfo).toBeDefined();
    expect(entry?.approvalInfo?.requiredQuorum).toBe(2);
    expect(entry?.approvalInfo?.currentVotes).toBe(1);
    expect(entry?.approvalInfo?.state).toBe('open');
  });

  it('E8-1-22: includes gate info when present', async () => {
    const plan = makeTaskPlan({ state: 'testing', runId: 'run-001' });
    const gate = makeGateRecord({
      runId: 'run-001',
      decision: 'hitl',
      blockedBy: 'user-bob',
    });
    taskPlanRepo.add(plan);
    gateRepo.add('run-001', gate);

    const entry = await service.getRunView('tenant-001', 'run-001');

    expect(entry?.gateInfo).toBeDefined();
    expect(entry?.gateInfo?.decision).toBe('hitl');
    expect(entry?.gateInfo?.blockedBy).toBe('user-bob');
  });

  it('E8-1-23: handles run with multiple gates', async () => {
    const plan = makeTaskPlan({ state: 'testing', runId: 'run-001' });
    const gate1 = makeGateRecord({ runId: 'run-001', stageIndex: 0, state: 'passed' });
    const gate2 = makeGateRecord({ runId: 'run-001', stageIndex: 1, state: 'blocked' });
    taskPlanRepo.add(plan);
    gateRepo.add('run-001', gate1);
    gateRepo.add('run-001', gate2);

    const entry = await service.getRunView('tenant-001', 'run-001');

    // 应该检测到一个阻塞的门禁
    expect(entry?.currentStage).toBe('blocked');
  });

  it('E8-1-24: all stages are valid StreamStage values', async () => {
    const stages: Array<{ state: string; expected: string }> = [
      { state: 'planned', expected: 'planned' },
      { state: 'reviewing', expected: 'reviewing' },
      { state: 'testing', expected: 'testing' },
      { state: 'security_check', expected: 'security' },
      { state: 'deploying', expected: 'deploying' },
      { state: 'deployed', expected: 'deployed' },
      { state: 'verified', expected: 'verified' },
      { state: 'failed', expected: 'failed' },
      { state: 'rolled_back', expected: 'rolled_back' },
    ];

    for (const { state, expected } of stages) {
      taskPlanRepo.add(makeTaskPlan({ state, runId: `run-${state}` }));
      const entry = await service.getRunView('tenant-001', `run-${state}`);
      expect(entry?.currentStage).toBe(expected);
      taskPlanRepo.clear();
    }
  });
});
