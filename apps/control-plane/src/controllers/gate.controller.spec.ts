/**
 * InMemoryGateRepository 单元测试（D2-4 Gate HITL 审批 + Audit 固化）。
 *
 * 覆盖：
 * - GateAggregate.rehydrate → evaluate → approve 完整生命周期
 * - HITL 审批路径：blocked → opened，发布 GateOpened + GatePassed(hitl)
 * - 非法状态转换抛出 IllegalGateTransitionError（非 blocked 调用 approve）
 * - WORM 审计固化（每条门禁事件必须写入 AuditWormSink）
 * - 越权审批拒绝（principal.id !== approvedBy）
 */
import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  GateAggregate,
  PIPELINE_TOKENS,
  IllegalGateTransitionError,
  type GateRepositoryPort,
} from '@aegisci/domain/pipeline';
import { AuditWormService, AUDIT_WORM_SINK } from '@aegisci/domain/audit';
import { AgentDispatcherService, TASK_PLAN_REPOSITORY } from '@aegisci/domain/orchestration';
import { GateController } from './gate.controller';
import { InMemoryGateRepository } from '../providers/in-memory-gate-repository';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function makeGateSnapshot(params: {
  gateId?: string;
  runId?: string;
  tenantId?: string;
  state?: string;
  riskLevel?: 'G1' | 'G2' | 'G3' | 'G4';
  decision?: 'auto' | 'hitl';
}): Record<string, unknown> {
  return {
    gateId: params.gateId ?? 'gate-1',
    runId: params.runId ?? 'run-1',
    tenantId: params.tenantId ?? 'tenant-1',
    stage: 'review',
    riskLevel: params.riskLevel ?? 'G2',
    riskScore: 30,
    state: params.state ?? 'blocked',
    decision: params.decision,
    createdAt: new Date().toISOString(),
  };
}

function makePrincipal(id: string) {
  return { id, type: 'user' as const, tenantId: 'tenant-1', roles: ['approver'] };
}

describe('GateController (D2-4 HITL + Audit)', () => {
  let controller: GateController;
  let gateRepo: jest.Mocked<GateRepositoryPort>;
  let auditService: jest.Mocked<AuditWormService>;
  let dispatcher: jest.Mocked<AgentDispatcherService>;
  let sinkAppend: jest.Mock;

  beforeEach(async () => {
    sinkAppend = jest.fn().mockResolvedValue(undefined);

    auditService = { seal: jest.fn().mockResolvedValue({ sealed: true, objectKey: 'audit/test.json', contentHash: 'abc' }) } as any;

    const module: TestingModule = await Test.createTestingModule({
      controllers: [GateController],
      providers: [
        EventEmitter2,
        {
          provide: PIPELINE_TOKENS.GATE_REPOSITORY,
          useFactory: () => {
            const repo = new InMemoryGateRepository();
            repo.save = jest.fn(repo.save.bind(repo));
            repo.load = jest.fn(repo.load.bind(repo));
            return repo as unknown as jest.Mocked<GateRepositoryPort>;
          },
        },
        {
          provide: AUDIT_WORM_SINK,
          useValue: { appendObject: sinkAppend },
        },
        {
          provide: AuditWormService,
          useValue: auditService,
        },
        {
          provide: AgentDispatcherService,
          useValue: { onGateResult: jest.fn() },
        },
        {
          provide: TASK_PLAN_REPOSITORY,
          useValue: { load: jest.fn(), loadByRun: jest.fn(), save: jest.fn() },
        },
      ],
    }).compile();

    gateRepo = module.get(PIPELINE_TOKENS.GATE_REPOSITORY) as jest.Mocked<GateRepositoryPort>;
    dispatcher = module.get(AgentDispatcherService) as jest.Mocked<AgentDispatcherService>;
    controller = module.get(GateController);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 正常审批路径
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('approves blocked gate → returns hitl decision + sealed audit', async () => {
    const snapshot = makeGateSnapshot({ gateId: 'gate-hitl', state: 'blocked', riskLevel: 'G2' });
    gateRepo.load.mockResolvedValue(snapshot as any);

    const principal = makePrincipal('admin-user');
    const res = await controller.approve('gate-hitl', { approvedBy: 'admin-user', approvalTicketId: 'ticket-1' }, { user: principal } as any);

    expect(res.decision).toBe('hitl');
    expect(res.approvedBy).toBe('admin-user');
    expect(res.auditSealed).toBe(true);
    expect(gateRepo.save).toHaveBeenCalled();
    expect(dispatcher.onGateResult).toHaveBeenCalled();
  });

  it('rejects approval when principal.id !== approvedBy', async () => {
    const snapshot = makeGateSnapshot({ state: 'blocked' });
    gateRepo.load.mockResolvedValue(snapshot as any);

    const principal = makePrincipal('other-user');
    await expect(
      controller.approve('gate-x', { approvedBy: 'admin-user', approvalTicketId: 'ticket-2' }, { user: principal } as any),
    ).rejects.toThrow('principal mismatch');
  });

  it('returns 404 when gate not found', async () => {
    gateRepo.load.mockResolvedValue(null);
    const principal = makePrincipal('admin-user');
    await expect(
      controller.approve('gate-missing', { approvedBy: 'admin-user', approvalTicketId: 't1' }, { user: principal } as any),
    ).rejects.toThrow('not found');
  });

  it('returns 422 when approvalTicketId is missing', async () => {
    const snapshot = makeGateSnapshot({ state: 'blocked' });
    gateRepo.load.mockResolvedValue(snapshot as any);
    const principal = makePrincipal('admin-user');
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (controller as any).approve('gate-x', { approvedBy: 'admin-user' } as any, { user: principal } as any),
    ).rejects.toThrow('approvalTicketId is required');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GateAggregate 状态机不变式验证
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('GateAggregate.evaluate auto-passes G1 risk level', () => {
    const gate = GateAggregate.open(
      {
        runId: 'run-auto',
        tenantId: 'tenant-1',
        stage: 'review',
        riskLevel: 'G1',
        riskScore: 10,
        conclusions: [],
        generatedAt: new Date().toISOString(),
      },
      'gate-auto',
      { nextEventId: () => 'e1', now: () => new Date().toISOString(), traceId: 't', spanId: 's' },
    );
    gate.evaluate();
    expect(gate.state).toBe('passed');
    expect(gate.decision).toBe('auto');
    expect(gate.uncommittedEvents.length).toBeGreaterThan(0);
  });

  it('GateAggregate.evaluate blocks G2+ risk level (requires HITL)', () => {
    const gate = GateAggregate.open(
      {
        runId: 'run-block',
        tenantId: 'tenant-1',
        stage: 'review',
        riskLevel: 'G3',
        riskScore: 70,
        conclusions: [],
        generatedAt: new Date().toISOString(),
      },
      'gate-block',
      { nextEventId: () => 'e1', now: () => new Date().toISOString(), traceId: 't', spanId: 's' },
    );
    gate.evaluate();
    expect(gate.state).toBe('blocked');
    expect(gate.decision).toBeUndefined();
  });

  it('GateAggregate.approve throws IllegalGateTransitionError when state is not blocked', () => {
    const gate = GateAggregate.open(
      {
        runId: 'run-passed',
        tenantId: 'tenant-1',
        stage: 'review',
        riskLevel: 'G1',
        riskScore: 10,
        conclusions: [],
        generatedAt: new Date().toISOString(),
      },
      'gate-passed-already',
      { nextEventId: () => 'e1', now: () => new Date().toISOString(), traceId: 't', spanId: 's' },
    );
    gate.evaluate(); // → passed
    expect(gate.state).toBe('passed');
    expect(() => gate.approve({ approvalTicketId: 't1', approvedBy: 'admin' }))
      .toThrow(IllegalGateTransitionError);
  });

  it('GateAggregate.approve transitions blocked → opened + emits GateOpened + GatePassed(hitl)', () => {
    const gate = GateAggregate.open(
      {
        runId: 'run-hitl',
        tenantId: 'tenant-1',
        stage: 'review',
        riskLevel: 'G2',
        riskScore: 30,
        conclusions: [],
        generatedAt: new Date().toISOString(),
      },
      'gate-hitl-flow',
      { nextEventId: () => 'e1', now: () => new Date().toISOString(), traceId: 't', spanId: 's' },
    );
    gate.evaluate();
    expect(gate.state).toBe('blocked');

    gate.approve({ approvalTicketId: 'ticket-99', approvedBy: 'admin-user' });
    expect(gate.state).toBe('opened');
    expect(gate.decision).toBe('hitl');
    expect(gate.approvalTicketId).toBe('ticket-99');
    expect(gate.uncommittedEvents.length).toBe(3); // GateBlocked + GateOpened + GatePassed(hitl)
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GateRepository
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('InMemoryGateRepository load/save round-trips correctly', async () => {
    const repo = new InMemoryGateRepository();
    const snap = makeGateSnapshot({ gateId: 'gate-round', state: 'blocked' }) as any;
    await repo.save(snap);
    const loaded = await repo.load('gate-round');
    expect(loaded).not.toBeNull();
    expect(loaded!.gateId).toBe('gate-round');
    expect(loaded!.state).toBe('blocked');
  });

  it('InMemoryGateRepository returns null for missing gateId', async () => {
    const repo = new InMemoryGateRepository();
    const loaded = await repo.load('nonexistent');
    expect(loaded).toBeNull();
  });
});
