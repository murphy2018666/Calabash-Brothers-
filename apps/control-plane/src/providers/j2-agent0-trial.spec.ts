/**
 * J2 Agent-0 试运行框架单元测试
 *
 * 验证：
 * - J2-1 Agent 注册与查询
 * - J2-2 试运行启动与阶段推进
 * - J2-3 工具调用记录与拒绝统计
 * - J2-4 试运行报告生成
 * - J2-5 风险等级评估
 */
import { Agent0TrialFramework, type TrialReport } from './j2-agent0-runner';
import type { AgentCard } from '@aegisci/shared/types';
import type { TraceSpan } from '@aegisci/core/spi/trace';

const makeAgent = (overrides: Partial<AgentCard> = {}): AgentCard => ({
  agentId: 'agent-test',
  role: 'reviewer',
  displayName: 'Test Reviewer',
  modelId: 'gpt-4',
  capabilities: ['read_file', 'echo'],
  riskTier: 'G2',
  tenantId: 't1',
  ...overrides,
});

const makeSpan = (overrides: Partial<TraceSpan> = {}): TraceSpan => ({
  spanId: 'span-1',
  traceId: 'trace-1',
  name: 'tool.echo',
  startTime: Date.now(),
  attributes: { 'tenant.id': 't1' },
  events: [],
  status: 'ok',
  ...overrides,
});

describe('J2 Agent-0 Trial Framework', () => {
  let framework: Agent0TrialFramework;

  beforeEach(() => {
    framework = new Agent0TrialFramework();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // J2-1 Agent 注册与查询
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('J2-1 Agent 注册', () => {
    it('J2-1-1: registerAgent stores agent', () => {
      const agent = makeAgent();
      framework.registerAgent(agent);
      expect(framework.getAgent('agent-test')).toEqual(agent);
    });

    it('J2-1-2: getAgent returns undefined for unknown agent', () => {
      expect(framework.getAgent('nonexistent')).toBeUndefined();
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // J2-2 试运行启动与阶段推进
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('J2-2 试运行生命周期', () => {
    it('J2-2-1: startTrial creates trial and returns trialId', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      expect(trialId).toBeTruthy();
      expect(trialId.startsWith('trial-')).toBe(true);
    });

    it('J2-2-2: startTrial throws for unknown agent', () => {
      expect(() => framework.startTrial({ tenantId: 't1', agentId: 'missing' }))
        .toThrow('not registered');
    });

    it('J2-2-3: startTrial defaults riskLevel from agent card', () => {
      framework.registerAgent(makeAgent({ riskTier: 'G3' }));
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      const trial = framework.getTrial(trialId);
      expect(trial!.riskLevel).toBe('G3');
    });

    it('J2-2-4: advancePhase progresses through stages', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      framework.advancePhase(trialId, 'shadow');
      framework.advancePhase(trialId, 'active');

      const trial = framework.getTrial(trialId);
      expect(trial!.phase).toBe('active');
    });

    it('J2-2-5: advancePhase to reported sets completedAt', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      framework.advancePhase(trialId, 'reported');
      const trial = framework.getTrial(trialId);
      expect(trial!.phase).toBe('reported');
      expect(trial!.completedAt).toBeTruthy();
    });

    it('J2-2-6: cannot regress phase', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      framework.advancePhase(trialId, 'shadow');
      expect(() => framework.advancePhase(trialId, 'sandbox'))
        .toThrow('cannot regress');
    });

    it('J2-2-7: advancePhase throws for unknown trial', () => {
      expect(() => framework.advancePhase('fake-trial', 'sandbox'))
        .toThrow('not found');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // J2-3 工具调用记录
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('J2-3 工具调用记录', () => {
    it('J2-3-1: recordToolCall increments counters', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      framework.recordToolCall({ trialId, span: makeSpan() });
      const trial = framework.getTrial(trialId);
      expect(trial!.toolCallCount).toBe(1);
      expect(trial!.spans).toHaveLength(1);
    });

    it('J2-3-2: recordToolCall with denied=true increments denyCount', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      framework.recordToolCall({ trialId, span: makeSpan(), denied: true });
      const trial = framework.getTrial(trialId);
      expect(trial!.denyCount).toBe(1);
    });

    it('J2-3-3: recordToolCall throws for unknown trial', () => {
      expect(() => framework.recordToolCall({ trialId: 'fake', span: makeSpan() }))
        .toThrow('not found');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // J2-4 试运行报告生成
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('J2-4 报告生成', () => {
    it('J2-4-1: generateReport produces structured report', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      framework.recordToolCall({ trialId, span: makeSpan({ endTime: Date.now() + 100 }) });
      framework.recordToolCall({ trialId, span: makeSpan({ endTime: Date.now() + 200 }) });

      const report = framework.generateReport(trialId) as TrialReport;
      expect(report.trialId).toBe(trialId);
      expect(report.tenantId).toBe('t1');
      expect(report.agentId).toBe('agent-test');
      expect(report.stats.totalToolCalls).toBe(2);
      expect(report.stats.totalSpans).toBe(2);
      expect(report.recommendations).toBeTruthy();
      expect(typeof report.riskAssessment).toBe('string');
    });

    it('J2-4-2: generateReport throws for unknown trial', () => {
      expect(() => framework.generateReport('unknown-trial'))
        .toThrow('not found');
    });

    it('J2-4-3: report includes recommendations when denies exist', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      framework.recordToolCall({ trialId, span: makeSpan(), denied: true });
      framework.recordToolCall({ trialId, span: makeSpan(), denied: true });

      const report = framework.generateReport(trialId) as TrialReport;
      expect(report.recommendations.some((r) => r.includes('拒绝'))).toBe(true);
    });

    it('J2-4-4: report includes recommendation when no spans', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });

      const report = framework.generateReport(trialId) as TrialReport;
      expect(report.recommendations.some((r) => r.includes('无工具调用'))).toBe(true);
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // J2-5 风险等级评估
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  describe('J2-5 风险评估', () => {
    it('J2-5-1: high deny ratio → high risk assessment', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      // 10 calls, 8 denied = 80% deny ratio
      for (let i = 0; i < 10; i++) {
        framework.recordToolCall({ trialId, span: makeSpan(), denied: i < 8 });
      }
      const report = framework.generateReport(trialId) as TrialReport;
      expect(report.riskAssessment).toContain('高风险');
    });

    it('J2-5-2: low deny ratio → manageable risk', () => {
      framework.registerAgent(makeAgent());
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      // 10 calls, 1 denied = 10% deny ratio
      for (let i = 0; i < 10; i++) {
        framework.recordToolCall({ trialId, span: makeSpan(), denied: i === 0 });
      }
      const report = framework.generateReport(trialId) as TrialReport;
      expect(report.riskAssessment).toContain('风险可控');
    });

    it('J2-5-3: G4 agent in sandbox is restricted', () => {
      framework.registerAgent(makeAgent({ riskTier: 'G4' }));
      const trialId = framework.startTrial({ tenantId: 't1', agentId: 'agent-test' });
      const report = framework.generateReport(trialId) as TrialReport;
      expect(report.riskAssessment).toContain('G4');
    });
  });
});
