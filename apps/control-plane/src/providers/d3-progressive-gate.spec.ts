import { randomUUID } from 'crypto';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ProgressiveGateChain } from './progressive-gate-chain';
import type { ProgressiveGateChainInit } from './progressive-gate-chain';
import type { GateRepositoryPort, RiskSummary } from '@aegisci/domain/pipeline';

/**
 * D3 ProgressiveGateChain 单元测试（递进门禁贯通）。
 *
 * 覆盖：
 * - 单阶段自动放行（G1）
 * - 多阶段串行递进
 * - HITL 审批后级联推进
 * - 单阶段阻塞时后续阶段不激活
 * - 完成状态检测
 * - 事件发布
 */
describe('D3 ProgressiveGateChain (递进门禁贯通)', () => {
  let chain: ProgressiveGateChain;
  let repo: GateRepositoryPort & { __store: Map<string, unknown> };
  let emitter: EventEmitter2;

  const makeRiskSummary = (
    stageIndex: number,
    riskLevel: 'G1' | 'G2' | 'G3',
  ): RiskSummary => ({
    runId: 'run-1',
    tenantId: 't1',
    stage: `stage-${stageIndex}`,
    riskLevel,
    riskScore: riskLevel === 'G1' ? 10 : riskLevel === 'G2' ? 35 : 75,
    conclusions: [],
    generatedAt: new Date().toISOString(),
  });

  beforeEach(() => {
    emitter = new EventEmitter2();
    repo = {
      __store: new Map(),
      async load(gateId: string) {
        return (this.__store.get(gateId) as unknown) ?? null;
      },
      async save(record: unknown) {
        this.__store.set((record as { gateId: string }).gateId, record);
      },
    } as unknown as GateRepositoryPort & { __store: Map<string, unknown> };
    chain = new ProgressiveGateChain(repo, emitter);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // D3-1: 单阶段自动放行（G1）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('D3-1-1: single G1 stage auto-passes without HITL', async () => {
    const init: ProgressiveGateChainInit = {
      chainId: 'chain-1',
      runId: 'run-1',
      tenantId: 't1',
      stages: [{ stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G1') }],
    };
    await chain.init(init);

    expect(chain.state).toBe('active');
    expect(chain.currentStage?.state).toBe('passed');
    expect(chain.currentStage?.decision).toBe('auto');
    expect(chain.isCompleted).toBe(true);
  });

  it('D3-1-2: repo.save() called during evaluation', async () => {
    const init: ProgressiveGateChainInit = {
      chainId: 'chain-2',
      runId: 'run-2',
      tenantId: 't1',
      stages: [{ stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G1') }],
    };
    await chain.init(init);

    const saved = repo.__store.get('gate-0');
    expect(saved).toBeDefined();
    expect((saved as { state: string }).state).toBe('passed');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // D3-2: 多阶段串行递进
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('D3-2-1: stage-0 G1 passes → stage-1 G1 auto-passes', async () => {
    const init: ProgressiveGateChainInit = {
      chainId: 'chain-3',
      runId: 'run-3',
      tenantId: 't1',
      stages: [
        { stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G1') },
        { stageIndex: 1, stageName: 'staging', riskSummary: makeRiskSummary(1, 'G1') },
      ],
    };
    await chain.init(init);

    expect(chain.isCompleted).toBe(true);
    expect(chain.getAllStages()[0].state).toBe('passed');
    expect(chain.getAllStages()[1].state).toBe('passed');
  });

  it('D3-2-2: stage-0 G2 blocks → stage-1 not evaluated yet', async () => {
    const init: ProgressiveGateChainInit = {
      chainId: 'chain-4',
      runId: 'run-4',
      tenantId: 't1',
      stages: [
        { stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G2') },
        { stageIndex: 1, stageName: 'staging', riskSummary: makeRiskSummary(1, 'G2') },
      ],
    };
    await chain.init(init);

    // stage-0 阻断，stage-1 还未被创建评估
    expect(chain.currentStage?.state).toBe('blocked');
    expect(chain.currentStage?.riskLevel).toBe('G2');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // D3-3: HITL 审批后级联推进
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('D3-3-1: HITL approve → stage-0 passed → stage-1 auto-evaluates', async () => {
    const init: ProgressiveGateChainInit = {
      chainId: 'chain-5',
      runId: 'run-5',
      tenantId: 't1',
      stages: [
        { stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G2') },
        { stageIndex: 1, stageName: 'staging', riskSummary: makeRiskSummary(1, 'G1') },
      ],
    };
    await chain.init(init);

    expect(chain.currentStage?.state).toBe('blocked');

    await chain.approve('ticket-1', 'admin-alice');

    // stage-0 审批通过（opened 状态，决策 hitl）
    expect(chain.getAllStages()[0].decision).toBe('hitl');
    // stage-1 自动评估并放行（G1）
    expect(chain.getAllStages()[1].state).toBe('passed');
    expect(chain.isCompleted).toBe(true);
  });

  it('D3-3-2: approve on non-blocked stage throws', async () => {
    const init: ProgressiveGateChainInit = {
      chainId: 'chain-6',
      runId: 'run-6',
      tenantId: 't1',
      stages: [{ stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G1') }],
    };
    await chain.init(init);

    await expect(chain.approve('ticket-1', 'admin-alice')).rejects.toThrow(/not blocked/);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // D3-4: 事件发布
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('D3-4-1: GatePassed event emitted on auto-pass', async () => {
    const spy = jest.fn();
    emitter.on('pipeline.gate.passed', spy);

    const init: ProgressiveGateChainInit = {
      chainId: 'chain-7',
      runId: 'run-7',
      tenantId: 't1',
      stages: [{ stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G1') }],
    };
    await chain.init(init);

    expect(spy).toHaveBeenCalled();
  });

  it('D3-4-2: GateBlocked event emitted on G2 block', async () => {
    const spy = jest.fn();
    emitter.on('pipeline.gate.blocked', spy);

    const init: ProgressiveGateChainInit = {
      chainId: 'chain-8',
      runId: 'run-8',
      tenantId: 't1',
      stages: [{ stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G2') }],
    };
    await chain.init(init);

    expect(spy).toHaveBeenCalled();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // D3-5: 边界条件
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('D3-5-1: empty stage list → immediate completion', async () => {
    const init: ProgressiveGateChainInit = {
      chainId: 'chain-9',
      runId: 'run-9',
      tenantId: 't1',
      stages: [],
    };
    await chain.init(init);

    expect(chain.isCompleted).toBe(true);
    expect(chain.stageCount).toBe(0);
  });

  it('D3-5-2: three-stage chain with mixed G1/G2/G1', async () => {
    const init: ProgressiveGateChainInit = {
      chainId: 'chain-10',
      runId: 'run-10',
      tenantId: 't1',
      stages: [
        { stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G1') },
        { stageIndex: 1, stageName: 'staging', riskSummary: makeRiskSummary(1, 'G2') },
        { stageIndex: 2, stageName: 'prod', riskSummary: makeRiskSummary(2, 'G1') },
      ],
    };
    await chain.init(init);

    // stage-0 G1 auto-pass → stage-1 G2 blocked
    expect(chain.currentStageIndex).toBe(1);
    expect(chain.currentStage?.state).toBe('blocked');

    // approve stage-1
    await chain.approve('ticket-2', 'admin-bob');

    // stage-1 opened → stage-2 G1 auto-pass → all completed
    expect(chain.getAllStages()[1].state).toBe('opened');
    expect(chain.getAllStages()[2].state).toBe('passed');
    expect(chain.isCompleted).toBe(true);
  });

  it('D3-5-3: state is active during processing', async () => {
    const init: ProgressiveGateChainInit = {
      chainId: 'chain-11',
      runId: 'run-11',
      tenantId: 't1',
      stages: [
        { stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G1') },
        { stageIndex: 1, stageName: 'staging', riskSummary: makeRiskSummary(1, 'G1') },
      ],
    };
    await chain.init(init);

    expect(chain.state).toBe('active');
    expect(chain.isCompleted).toBe(true);
  });

  it('D3-5-4: getStageSnapshot returns stored state', async () => {
    const init: ProgressiveGateChainInit = {
      chainId: 'chain-12',
      runId: 'run-12',
      tenantId: 't1',
      stages: [{ stageIndex: 0, stageName: 'sandbox', riskSummary: makeRiskSummary(0, 'G1') }],
    };
    await chain.init(init);

    const snapshot = await chain.getStageSnapshot(0);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.state).toBe('passed');
  });
});
