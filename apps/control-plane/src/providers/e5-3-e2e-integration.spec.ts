/**
 * E5-3: Reviewer-Agent 端到端集成测试
 *
 * 覆盖：
 * - PR 触发 → TaskPlan 创建 → Reviewer 分派 → 结论收集 → RiskSummaryReady → Gate 裁决
 * - 与 E1 FSM、E2 AgentCard/LLM、E5-1 ReviewerPromptService、E5-2 EvaluatorBaselineService 联动
 *
 * 测试策略：
 * - 使用 InMemory 仓储和 Stub 组件模拟外部依赖
 * - 验证端到端链路的状态流转正确性
 */
import { Test } from '@nestjs/testing';
import { ReviewerPromptService } from './reviewer-prompt.service';
import { EvaluatorBaselineService } from './evaluator-baseline.service';
import { AgentCardRegistryService } from './agent-card-registry.service';
import { InMemoryAgentProvider } from './in-memory-agent-provider';
import { TaskPlan } from '@aegisci/domain/orchestration';
import type { AgentRole, RiskLevel } from '@aegisci/shared/types';
import { SPI_TOKENS } from '@aegisci/core/spi';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// InMemory 仓储桩
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class InMemoryTaskPlanRepo {
  private store = new Map<string, TaskPlan>();

  async save(plan: TaskPlan): Promise<void> {
    this.store.set(plan.taskPlanId, plan);
  }

  async load(id: string): Promise<TaskPlan | null> {
    return this.store.get(id) ?? null;
  }

  async loadByRun(runId: string): Promise<TaskPlan | null> {
    for (const plan of this.store.values()) {
      if (plan.runId === runId) return plan;
    }
    return null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试套件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('E5-3 Reviewer-Agent 端到端集成', () => {
  let taskPlanRepo: InMemoryTaskPlanRepo;
  let promptService: ReviewerPromptService;
  let evaluator: EvaluatorBaselineService;
  let registry: AgentCardRegistryService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [
        ReviewerPromptService,
        { provide: EvaluatorBaselineService, useValue: new EvaluatorBaselineService() },
        AgentCardRegistryService,
        InMemoryAgentProvider,
        { provide: SPI_TOKENS.AGENT_PROVIDER, useExisting: InMemoryAgentProvider },
      ],
    }).compile();

    taskPlanRepo = new InMemoryTaskPlanRepo();
    promptService = moduleRef.get<ReviewerPromptService>(ReviewerPromptService);
    evaluator = moduleRef.get<EvaluatorBaselineService>(EvaluatorBaselineService);
    registry = moduleRef.get<AgentCardRegistryService>(AgentCardRegistryService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 完整链路测试
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('端到端链路：PR 触发 → Reviewer 分派 → 结论收集 → RiskSummaryReady', () => {
    it('应完成完整流程并生成 RiskSummaryReady', async () => {
      // 1. 注册 Reviewer AgentCard（通过底层 provider）
      await (registry as any).agentProvider.register({
        agentId: 'reviewer-1',
        role: 'reviewer' as AgentRole,
        displayName: 'Security Reviewer',
        modelId: 'stub-model',
        capabilities: ['git.diff', 'security.scan'],
        riskTier: 'G2',
        tenantId: 'tenant-1',
      });

      // 2. 创建 TaskPlan（G2 = AutoLowRisk，直接进 Dispatching）
      const plan = TaskPlan.fromPrContext(
        'taskplan-e2e-001',
        {
          runId: 'run-e2e-001',
          tenantId: 'tenant-1',
          trigger: 'pr.created' as any,
          diffRef: 'abc123',
          changedFiles: ['src/auth.ts', 'src/config.ts'],
          riskHint: 'G2' as RiskLevel,
          globalConstraints: [],
        },
        'planner-1',
        [
          { role: 'reviewer' as AgentRole, agentId: 'reviewer-1', tokenBudget: 8000 },
        ],
      );

      // 3. 分派 Planner（Planning→Dispatching）
      plan.dispatchNext(
        { blackboardSessionId: 'bb-session-001' } as any,
        () => ({ eventId: 'e1', eventType: 'or.agent.dispatched', aggregateId: 'tp-1', aggregateType: 'TaskPlan', tenantId: 'tenant-1', payload: { runId: 'run-e2e-001', taskPlanId: 'taskplan-e2e-001', agentId: 'planner-1', role: 'planner', tokenBudget: 4000, blackboardSnapshotRef: 'bb-session-001', mode: 'M1_blackboard' }, timestamp: new Date().toISOString(), traceId: '', spanId: '' }) as any,
      );
      expect(plan.state).toBe('Dispatching');

      // planner 完成 → reviewer 依赖满足
      (plan.tasks.find((t) => t.role === 'planner') as any).concluded = true;

      // 4. 分派 Reviewer（所有任务已分派 → AwaitingAgents）
      plan.dispatchNext(
        { blackboardSessionId: 'bb-session-001' } as any,
        () => ({ eventId: 'e2', eventType: 'or.agent.dispatched', aggregateId: 'tp-1', aggregateType: 'TaskPlan', tenantId: 'tenant-1', payload: { runId: 'run-e2e-001', taskPlanId: 'taskplan-e2e-001', agentId: 'reviewer-1', role: 'reviewer', tokenBudget: 8000, blackboardSnapshotRef: 'bb-session-001', mode: 'M1_blackboard' }, timestamp: new Date().toISOString(), traceId: '', spanId: '' }) as any,
      );
      expect(plan.state).toBe('AwaitingAgents');

      await taskPlanRepo.save(plan);

      // 4. 收集 Reviewer 结论
      plan.collectConclusion('taskplan-e2e-001#reviewer', 'bb-entry-001', () => {});

      await taskPlanRepo.save(plan);
      // collectConclusion → ConclusionsAggregated → publishRiskSummary → AwaitingGateResult
      expect(plan.state).toBe('AwaitingGateResult');

      // 5. 验证 RiskSummaryReady 事件已生成
      const events = plan.pullPendingEvents();
      const riskEvent = events.find((e: any) => e.eventType === 'or.risk.summary.ready');
      expect(riskEvent).toBeDefined();
      expect(riskEvent.payload.runId).toBe('run-e2e-001');
      expect(riskEvent.payload.contributors).toContain('reviewer-1');
    });

    it('端到端链路失败时不应进入终态', () => {
      const plan = TaskPlan.fromPrContext(
        'taskplan-e2e-fail',
        {
          runId: 'run-e2e-fail',
          tenantId: 'tenant-1',
          trigger: 'pr.created' as any,
          diffRef: 'xyz',
          changedFiles: [],
          riskHint: 'G1' as RiskLevel,
          globalConstraints: [],
        },
        'planner-1',
        [],
      );

      // 未分派任何 Agent，处于 Planning（G1=AutoLowRisk 自动批准，但无任务可分派）
      expect(plan.state).toBe('Planning');
      expect(plan.state).not.toBe('Done');
    });

    it('Reviewer 结论收集后应推进到 AwaitingGateResult', () => {
      const plan = TaskPlan.fromPrContext(
        'taskplan-e2e-summary',
        {
          runId: 'run-e2e-summary',
          tenantId: 'tenant-1',
          trigger: 'pr.created' as any,
          diffRef: 'xyz',
          changedFiles: [],
          riskHint: 'G2' as RiskLevel,
          globalConstraints: [],
        },
        'planner-1',
        [{ role: 'reviewer' as AgentRole, agentId: 'reviewer-1', tokenBudget: 8000 }],
      );

      // 手动分派 Planner（第一笔：Planning → Dispatching）
      plan.dispatchNext(
        { blackboardSessionId: 'bb-sess' } as any,
        () => ({ eventId: 'e1', eventType: 'or.agent.dispatched', aggregateId: 'tp-1', aggregateType: 'TaskPlan', tenantId: 'tenant-1', payload: { runId: 'run-e2e-summary', taskPlanId: 'taskplan-e2e-summary', agentId: 'planner-1', role: 'planner', tokenBudget: 4000, blackboardSnapshotRef: 'bb-sess', mode: 'M1_blackboard' }, timestamp: new Date().toISOString(), traceId: '', spanId: '' }) as any,
      );
      // planner 完成，使 reviewer 的依赖满足
      (plan.tasks.find((t) => t.role === 'planner') as any).concluded = true;
      // 手动分派 Reviewer（第二笔：Dispatching → AwaitingAgents）
      plan.dispatchNext(
        { blackboardSessionId: 'bb-sess' } as any,
        () => ({ eventId: 'e2', eventType: 'or.agent.dispatched', aggregateId: 'tp-1', aggregateType: 'TaskPlan', tenantId: 'tenant-1', payload: { runId: 'run-e2e-summary', taskPlanId: 'taskplan-e2e-summary', agentId: 'reviewer-1', role: 'reviewer', tokenBudget: 8000, blackboardSnapshotRef: 'bb-sess', mode: 'M1_blackboard' }, timestamp: new Date().toISOString(), traceId: '', spanId: '' }) as any,
      );
      expect(plan.state).toBe('AwaitingAgents');

      // 收集结论 → 推进到 AwaitingGateResult
      plan.collectConclusion('taskplan-e2e-summary#reviewer', 'bb-entry-1', () => {});
      expect(plan.state).toBe('AwaitingGateResult');
    });

    it('Gate 裁决事件应推进 OR FSM 到 Done', () => {
      const plan = TaskPlan.fromPrContext(
        'taskplan-e2e-gate',
        {
          runId: 'run-e2e-gate',
          tenantId: 'tenant-1',
          trigger: 'pr.created' as any,
          diffRef: 'xyz',
          changedFiles: [],
          riskHint: 'G2' as RiskLevel,
          globalConstraints: [],
        },
        'planner-1',
        [],
      );

      // 手动推进到 AwaitingGateResult（模拟已完成 RiskSummaryPublished）
      // Planning → Dispatching (approve) → AwaitingAgents (AllAgentsDispatched, no tasks)
      plan.approve(); // Planning → Dispatching
      expect(plan.state).toBe('Dispatching');
      // 无任务，dispatchNext 内部自动推进 → AwaitingAgents，再 CollectConclusion 自动推进
      // 直接推过 ConclusionsAggregated → AwaitingGateResult
      (plan as any).sm.transition('AllAgentsDispatched');   // Dispatching → AwaitingAgents
      (plan as any).sm.transition('AllAgentsConcluded');   // AwaitingAgents → ConclusionsAggregated
      (plan as any).sm.transition('RiskSummaryPublished'); // ConclusionsAggregated → AwaitingGateResult
      expect(plan.state).toBe('AwaitingGateResult');

      // 收到 Gate 结果 → Done（终态）
      plan.onGateResult();
      expect(plan.state).toBe('Done');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 与 Evaluator 联动测试
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('与评测基准联动', () => {
    it('Reviewer 输出应与人工标注基准进行一致性评估', () => {
      evaluator.registerBaseline({
        prId: 'run-e2e-eval',
        findings: [
          { file: 'src/auth.ts', line: 12, severity: 'critical', ruleId: 'R-SEC-001', description: 'Hardcoded password' },
          { file: 'src/query.ts', line: 45, severity: 'high', ruleId: 'R-SEC-003', description: 'SQL injection' },
        ],
        expectedRiskLevel: 'G2',
        annotatedAt: '2026-09-01T00:00:00Z',
      });

      const score = evaluator.evaluate('run-e2e-eval', {
        findings: [
          { file: 'src/auth.ts', line: 12, severity: 'critical', ruleId: 'R-SEC-001', description: 'Hardcoded password' },
          { file: 'src/query.ts', line: 45, severity: 'high', ruleId: 'R-SEC-003', description: 'SQL injection' },
        ],
        riskLevel: 'G2',
      });

      expect(score.consistencyScore).toBeCloseTo(1.0, 0.01);
      expect(evaluator.passThreshold(score)).toBe(true);
    });

    it('偏差超过阈值时应触发告警', () => {
      evaluator.registerBaseline({
        prId: 'run-e2e-alert',
        findings: [
          { file: 'src/auth.ts', line: 12, severity: 'critical', ruleId: 'R-SEC-001', description: 'Hardcoded password' },
        ],
        expectedRiskLevel: 'G1',
        annotatedAt: '2026-09-01T00:00:00Z',
      });

      const score = evaluator.evaluate('run-e2e-alert', {
        findings: [], // 完全漏检
        riskLevel: 'G4',
      });

      const alert = evaluator.generateDeviationAlert('run-e2e-alert', score);
      expect(alert).not.toBeNull();
      expect(alert!.alertLevel).toBe('critical');
    });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 提示工程联动测试
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  describe('提示工程与规则集注入', () => {
    it('生成的提示应包含安全规则集', () => {
      const prompt = promptService.generate(
        {
          prTitle: 'Add SQL query',
          prDescription: 'New parameterized query',
          changedFiles: ['src/db.ts'],
          riskLevel: 'G2',
        },
        'span-prompt-001',
      );

      expect(prompt.systemPrompt).toContain('R-SEC-003');
      expect(prompt.systemPrompt).toContain('SQL 注入防护');
      expect(prompt.userPrompt).toContain('Add SQL query');
    });

    it('自定义规则应追加到默认规则集', () => {
      promptService.addRule({
        ruleId: 'R-CUSTOM-001',
        description: '自定义规则',
        severity: 'low',
        check: '检查自定义逻辑',
      });

      const rules = promptService.getAllRules();
      expect(rules).toHaveLength(7); // 6 默认 + 1 自定义
      expect(rules.find((r) => r.ruleId === 'R-CUSTOM-001')).toBeDefined();
    });

    it('输出验证应检测缺失字段', () => {
      const issues = promptService.validateOutput({
        findings: [],
        summary: 'OK',
        // 缺少 riskLevel 和 traceSpanId
      });
      expect(issues).toContainEqual(expect.stringContaining('Missing required field: riskLevel'));
      expect(issues).toContainEqual(expect.stringContaining('Missing required field: traceSpanId'));
    });

    it('有效输出应通过验证', () => {
      const issues = promptService.validateOutput({
        findings: [
          { file: 'src/x.ts', severity: 'high', ruleId: 'R-SEC-001', description: 'Issue' },
        ],
        summary: 'One issue found',
        riskLevel: 'G2',
        traceSpanId: 'span-abc123',
      });
      expect(issues).toHaveLength(0);
    });
  });
});
