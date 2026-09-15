/**
 * E7-1: OpsPromptService 单元测试
 *
 * 覆盖：
 * - 提示生成（系统提示 + 用户提示）
 * - 发布规则集注入
 * - 自定义规则增删
 * - 输出验证（schema 合规性）
 * - traceSpanId 传播
 * - 生产环境高危警告
 * - 金丝雀指标注入
 * - deploy-token TTL 约束
 */
import { Test } from '@nestjs/testing';
import { OpsPromptService } from './ops-prompt.service';

describe('E7-1 OpsPromptService', () => {
  let service: OpsPromptService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OpsPromptService],
    }).compile();
    service = moduleRef.get<OpsPromptService>(OpsPromptService);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 提示生成
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E7-1-1: generates system prompt with ops rules', () => {
    const prompt = service.generate(makeContext(), 'span-123');

    expect(prompt.systemPrompt).toContain('Ops-Agent');
    expect(prompt.systemPrompt).toContain('R-OPS-001');
    expect(prompt.systemPrompt).toContain('变更 Diff 完整性');
    expect(prompt.traceSpanId).toBe('span-123');
  });

  it('E7-1-2: generates user prompt with PR context', () => {
    const context = makeContext({
      prTitle: 'Deploy auth service',
      targetEnvironment: 'production',
      changedFiles: ['src/auth.ts', 'src/deploy/argocd.yaml'],
    });
    const prompt = service.generate(context, 'span-456');

    expect(prompt.userPrompt).toContain('Deploy auth service');
    expect(prompt.userPrompt).toContain('src/auth.ts');
    expect(prompt.userPrompt).toContain('src/deploy/argocd.yaml');
  });

  it('E7-1-3: includes diff summary in user prompt', () => {
    const prompt = service.generate(
      makeContext({ diffSummary: 'Added JWT token validation in auth middleware' }),
      'span-diff',
    );

    expect(prompt.userPrompt).toContain('Added JWT token validation in auth middleware');
  });

  it('E7-1-4: includes rollback plan in user prompt', () => {
    const prompt = service.generate(
      makeContext({ rollbackPlan: 'Step 1: Revert argocd sync. Step 2: Rollback DB migration.' }),
      'span-rb',
    );

    expect(prompt.userPrompt).toContain('Step 1: Revert argocd sync');
  });

  it('E7-1-5: includes canary metrics in user prompt', () => {
    const prompt = service.generate(
      makeContext({ targetEnvironment: 'production', canaryMetrics: 'Error rate: 0.1%, Latency p99: 45ms' }),
      'span-canary',
    );

    expect(prompt.userPrompt).toContain('Error rate: 0.1%');
    expect(prompt.userPrompt).toContain('Latency p99: 45ms');
  });

  it('E7-1-6: includes deploy target in user prompt', () => {
    const prompt = service.generate(
      makeContext({ deployTarget: 'argocd: myapp-prod' }),
      'span-target',
    );

    expect(prompt.userPrompt).toContain('argocd: myapp-prod');
  });

  it('E7-1-7: includes token TTL in user prompt', () => {
    const prompt = service.generate(
      makeContext({ tokenTtlSeconds: 600 }),
      'span-ttl',
    );

    expect(prompt.userPrompt).toContain('Token TTL');
    expect(prompt.userPrompt).toContain('600');
  });

  it('E7-1-8: includes extra context when provided', () => {
    const prompt = service.generate(
      makeContext({ extraContext: 'High-traffic service, must use canary deployment' }),
      'span-ext',
    );

    expect(prompt.userPrompt).toContain('High-traffic service');
  });

  it('E7-1-9: system prompt includes high-risk warning for production env', () => {
    const prompt = service.generate(
      makeContext({ targetEnvironment: 'production' }),
      'span-prod',
    );

    expect(prompt.systemPrompt).toContain('高危发布警告');
    expect(prompt.systemPrompt).toContain('G4 高危动作');
    expect(prompt.systemPrompt).toContain('双人审批');
  });

  it('E7-1-10: system prompt does not include high-risk warning for staging env', () => {
    const prompt = service.generate(
      makeContext({ targetEnvironment: 'staging' }),
      'span-stg',
    );

    expect(prompt.systemPrompt).not.toContain('高危发布警告');
  });

  it('E7-1-11: output schema has required fields', () => {
    const prompt = service.generate(makeContext(), 'span-schema');

    expect(prompt.outputSchema.required).toContain('changeDiff');
    expect(prompt.outputSchema.required).toContain('rollbackPlan');
    expect(prompt.outputSchema.required).toContain('deployTokenRequest');
    expect(prompt.outputSchema.required).toContain('summary');
    expect(prompt.outputSchema.required).toContain('riskLevel');
    expect(prompt.outputSchema.required).toContain('traceSpanId');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 发布规则管理
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E7-1-12: has 8 default ops rules', () => {
    const rules = service.getAllRules();
    expect(rules).toHaveLength(8);
    expect(rules[0].ruleId).toBe('R-OPS-001');
    // Verify MITRE tags present
    expect(rules[1].mitreTactic).toBe('Defense Evasion');
    expect(rules[5].mitreTactic).toBe('Privilege Escalation');
  });

  it('E7-1-13: addRule appends custom rule', () => {
    service.addRule({
      ruleId: 'R-CUSTOM-OPS-001',
      description: 'Custom ops rule',
      severity: 'low',
      check: 'Custom check',
    });

    const rules = service.getAllRules();
    expect(rules).toHaveLength(9);
    expect(rules[8].ruleId).toBe('R-CUSTOM-OPS-001');
  });

  it('E7-1-14: removeRule removes custom rule', () => {
    service.addRule({ ruleId: 'R-TEMP-OPS', description: 'temp', severity: 'low', check: 't' });
    expect(service.getAllRules()).toHaveLength(9);

    service.removeRule('R-TEMP-OPS');
    expect(service.getAllRules()).toHaveLength(8);
  });

  it('E7-1-15: removeRule returns false for non-existent rule', () => {
    expect(service.removeRule('R-NONEXIST-OPS')).toBe(false);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 输出验证
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E7-1-16: validates correct output structure', () => {
    const validOutput = {
      changeDiff: {
        files: [
          { path: 'src/auth.ts', impact: 'critical', summary: 'Added JWT validation' },
        ],
      },
      rollbackPlan: {
        steps: [
          { step: 1, action: 'Revert argocd sync', validation: 'App returns 200', maxDuration: '2m' },
        ],
      },
      deployTokenRequest: {
        tokenScope: 'prod-scoped',
        tokenTtlSeconds: 600,
        targetEnvironment: 'production',
      },
      summary: 'Auth service release with JWT improvements',
      riskLevel: 'G3',
      traceSpanId: 'span-valid-ops',
    };

    const issues = service.validateOutput(validOutput);
    expect(issues).toEqual([]);
  });

  it('E7-1-17: detects missing required fields', () => {
    const incompleteOutput = {
      changeDiff: {},
      rollbackPlan: {},
      deployTokenRequest: {},
      // 缺少 summary, riskLevel, traceSpanId
    };

    const issues = service.validateOutput(incompleteOutput);
    expect(issues).toContain('Missing required field: summary');
    expect(issues).toContain('Missing required field: riskLevel');
    expect(issues).toContain('Missing required field: traceSpanId');
  });

  it('E7-1-18: detects invalid riskLevel', () => {
    const output = {
      changeDiff: { files: [] },
      rollbackPlan: { steps: [] },
      deployTokenRequest: { tokenScope: 'prod' },
      summary: 'test',
      riskLevel: 'G5',
      traceSpanId: 'span-x',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('Invalid riskLevel'))).toBe(true);
  });

  it('E7-1-19: detects tokenTtlSeconds > 900', () => {
    const output = {
      changeDiff: { files: [] },
      rollbackPlan: { steps: [] },
      deployTokenRequest: {
        tokenScope: 'prod',
        tokenTtlSeconds: 1800,
        targetEnvironment: 'production',
      },
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'span-y',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('tokenTtlSeconds'))).toBe(true);
  });

  it('E7-1-20: allows valid tokenTtlSeconds within limit', () => {
    const output = {
      changeDiff: { files: [] },
      rollbackPlan: { steps: [] },
      deployTokenRequest: {
        tokenScope: 'prod',
        tokenTtlSeconds: 900,
        targetEnvironment: 'production',
      },
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'span-ok',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('tokenTtlSeconds'))).toBe(false);
  });

  it('E7-1-21: detects rollback step with missing fields', () => {
    const output = {
      changeDiff: { files: [] },
      rollbackPlan: {
        steps: [{ step: 1 }], // 缺少 action 和 validation
      },
      deployTokenRequest: { tokenScope: 'prod', targetEnvironment: 'production' },
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'span-rb',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('RollbackStep[0] missing'))).toBe(true);
  });

  it('E7-1-22: detects changed file with missing fields', () => {
    const output = {
      changeDiff: {
        files: [{ path: 'src/x.ts' }], // 缺少 impact 和 summary
      },
      rollbackPlan: { steps: [] },
      deployTokenRequest: { tokenScope: 'prod', targetEnvironment: 'production' },
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'span-file',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('ChangedFile[0] missing'))).toBe(true);
  });

  it('E7-1-23: detects short traceSpanId', () => {
    const output = {
      changeDiff: { files: [] },
      rollbackPlan: { steps: [] },
      deployTokenRequest: { tokenScope: 'prod', targetEnvironment: 'production' },
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'ab',
    };

    const issues = service.validateOutput(output);
    expect(issues.some((i) => i.includes('traceSpanId too short'))).toBe(true);
  });

  it('E7-1-24: allows valid traceSpanId with sufficient length', () => {
    const output = {
      changeDiff: { files: [] },
      rollbackPlan: { steps: [] },
      deployTokenRequest: { tokenScope: 'prod', targetEnvironment: 'production' },
      summary: 'test',
      riskLevel: 'G2',
      traceSpanId: 'span-ops-123',
    };

    const issues = service.validateOutput(output);
    expect(issues).toEqual([]);
  });

  it('E7-1-25: validates complete production deploy output', () => {
    const output = {
      changeDiff: {
        files: [
          { path: 'src/auth/jwt.ts', impact: 'critical', summary: 'Added token refresh logic', riskFactor: 'Auth bypass risk' },
          { path: 'k8s/deployment.yaml', impact: 'high', summary: 'Updated image tag', riskFactor: 'Rolling update' },
        ],
      },
      rollbackPlan: {
        steps: [
          { step: 1, action: 'Revert argocd sync', validation: 'kubectl rollout status', maxDuration: '3m' },
          { step: 2, action: 'Rollback DB migration', validation: 'Data integrity check', maxDuration: '5m' },
        ],
      },
      deployTokenRequest: {
        tokenScope: 'prod-scoped',
        tokenTtlSeconds: 900,
        targetEnvironment: 'production',
      },
      risks: ['JWT token refresh introduces auth complexity', 'DB migration rollback may lose data'],
      summary: 'Auth service v2.3 release with token refresh feature for production',
      riskLevel: 'G4',
      traceSpanId: 'span-full-prod-ops',
    };

    const issues = service.validateOutput(output);
    expect(issues).toEqual([]);
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 辅助函数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function makeContext(overrides: Partial<OpsPromptContext> = {}): OpsPromptContext {
  return {
    prTitle: 'Ops PR',
    prDescription: 'Ops description',
    changedFiles: ['src/deploy.ts'],
    riskLevel: 'G2',
    targetEnvironment: 'staging',
    ...overrides,
  };
}
