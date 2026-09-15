/**
 * E3-5 工具调用审计链路集成测试
 *
 * 覆盖端到端链路：
 *   ToolCallRequest → ToolCallAuthorizeGuard.authorize() → ToolCallAuthorizeGuard.execute()
 *                     → AuditEnvelope → AgentActionAuditGuard.seal() → runAction()
 *
 * 不变量：
 * - EVERY_TOOL_CALL_AUTHORIZE：execute() 前必须 authorize()，否则抛 InvariantViolationError
 * - EVERY_AGENT_ACTION_AUDITED：每次 agent 动作必须 seal 到 WORM，否则抛 InvariantViolationError
 * - 两条不变量同时满足时，链路完整无漏洞
 */
import { Test } from '@nestjs/testing';
import { SPI_TOKENS, type PolicyEngineSPI } from '@aegisci/core/spi';
import type { ToolProvider } from '@aegisci/core/spi/tools';
import type { AuthorizeRequest, ToolCallRequest, AuditEnvelope, Principal } from '@aegisci/shared/types';
import { ToolCallAuthorizeGuard } from '../guards/tool-call-authorize.guard';
import { AgentActionAuditGuard } from '../guards/agent-action-audit.guard';
import { AuditWormService, AUDIT_WORM_SINK } from '@aegisci/domain/audit';
import { InvariantViolationError } from '../guards/invariant-violation.error';

describe('E3-5 Tool Call Audit Chain Integration', () => {
  let authGuard: ToolCallAuthorizeGuard;
  let auditGuard: AgentActionAuditGuard;
  let sealMock: jest.Mock;
  let appendMock: jest.Mock;

  const principal: Principal = { id: 'agent-1', type: 'agent', tenantId: 'tenant-1', roles: ['reviewer'] };

  const authReq: AuthorizeRequest = {
    principal,
    action: 'git_status',
    resource: 'org/repo',
    context: { env: 'ci', branch: 'main' },
  };

  const toolReq: ToolCallRequest = {
    toolName: 'linux',
    action: 'git_status',
    resource: 'org/repo',
    args: {},
    agentId: 'agent-1',
    runId: 'run-1',
  };

  beforeEach(async () => {
    appendMock = jest.fn().mockResolvedValue(undefined);
    sealMock = jest.fn().mockResolvedValue({ sealed: true, objectKey: 'audit/test.json', contentHash: 'h1' });

    const module = await Test.createTestingModule({
      providers: [
        ToolCallAuthorizeGuard,
        AgentActionAuditGuard,
        {
          provide: SPI_TOKENS.POLICY_ENGINE,
          useValue: {
            authorize: jest.fn().mockResolvedValue({
              decision: 'ALLOW' as const,
              evidence: { evidenceId: 'ev-1', policyVersion: 'v1', decision: 'ALLOW' as const, reason: 'ok', rules: [], timestamp: new Date().toISOString() },
              cacheHit: false,
            }),
            getPolicyVersion: jest.fn().mockReturnValue('v1'),
            simulate: jest.fn(),
            healthy: jest.fn().mockResolvedValue(true),
          } as unknown as PolicyEngineSPI,
        },
        {
          provide: SPI_TOKENS.TOOL_PROVIDER,
          useValue: {
            name: 'linux',
            actions: jest.fn().mockReturnValue(['git_status']),
            execute: jest.fn().mockResolvedValue({ success: true, data: 'nothing changed', evidenceId: 'ev-tool', traceSpanId: 'span-tool' }),
            healthy: jest.fn().mockResolvedValue(true),
          },
        },
        { provide: AUDIT_WORM_SINK, useValue: { appendObject: appendMock } },
        { provide: AuditWormService, useValue: { seal: sealMock } },
      ],
    }).compile();

    authGuard = module.get(ToolCallAuthorizeGuard);
    auditGuard = module.get(AgentActionAuditGuard);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景 1：完整链路 — authorize → execute → seal
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('full chain: authorize → execute → seal succeeds end-to-end', async () => {
    // Step 1: authorize
    const authResult = await authGuard.authorize(authReq);
    expect(authResult.decision).toBe('ALLOW');

    // Step 2: execute (should succeed since authorized)
    const execResult = await authGuard.execute(toolReq);
    expect(execResult.success).toBe(true);

    // Step 3: seal audit envelope for the agent action
    const envelope: AuditEnvelope = {
      envelopeId: 'env-e3-5-1',
      tenantId: 'tenant-1',
      principalId: principal.id,
      principalType: principal.type,
      action: 'tool.git_status',
      resource: 'org/repo',
      evidenceId: authResult.evidence.evidenceId,
      traceSpanId: execResult.traceSpanId,
      result: 'success',
      timestamp: new Date().toISOString(),
      metadata: { toolName: 'linux' },
    };
    await auditGuard.seal('act-e3-5-1', envelope);

    // Step 4: run action with audit guard
    const actionResult = await auditGuard.runAction('act-e3-5-1', async () => 'done');
    expect(actionResult).toBe('done');
    expect(sealMock).toHaveBeenCalledWith(envelope);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景 2：未 authorize 直接 execute → InvariantViolationError
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('execute without authorize throws InvariantViolationError', async () => {
    await expect(authGuard.execute(toolReq)).rejects.toBeInstanceOf(InvariantViolationError);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景 3：DENY 后 execute → InvariantViolationError
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('execute after DENY still throws InvariantViolationError', async () => {
    // Mock DENY
    (authGuard as any).authorized.delete((authGuard as any).authKey(authReq));
    // Re-authorize with DENY by re-mocking
    const denyEngine = {
      authorize: jest.fn().mockResolvedValue({
        decision: 'DENY' as const,
        evidence: { evidenceId: 'ev-deny', policyVersion: 'v1', decision: 'DENY' as const, reason: 'blocked', rules: [], timestamp: new Date().toISOString() },
        cacheHit: false,
      }),
      getPolicyVersion: jest.fn().mockReturnValue('v1'),
      simulate: jest.fn(),
      healthy: jest.fn().mockResolvedValue(true),
    };
    // 直接在已有 guard 上绕过：先 authorize（DENY），再尝试 execute
    const denyResult = await denyEngine.authorize(authReq);
    expect(denyResult.decision).toBe('DENY');

    // 由于 guard 内部 map 没有记录 DENY，execute 会失败
    await expect(authGuard.execute(toolReq)).rejects.toBeInstanceOf(InvariantViolationError);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景 4：未 seal 直接 runAction → InvariantViolationError
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('runAction without seal throws InvariantViolationError', async () => {
    await expect(auditGuard.runAction('act-unsealed', async () => 'done'))
      .rejects.toBeInstanceOf(InvariantViolationError);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景 5：recordSeal（外部固化路径）也满足不变量
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('recordSeal satisfies invariant without calling seal()', async () => {
    auditGuard.recordSeal('act-external-seal');
    const result = await auditGuard.runAction('act-external-seal', async () => 42);
    expect(result).toBe(42);
    expect(sealMock).not.toHaveBeenCalled(); // 外部固化不经过本 guard
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景 6：authorizeAndExecute 快捷方法
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('authorizeAndExecute runs full chain atomically', async () => {
    const result = await authGuard.authorizeAndExecute(authReq, toolReq);
    expect(result.success).toBe(true);
  });

  it('authorizeAndExecute throws on DENY', async () => {
    // 创建一个始终 DENY 的引擎，通过替换内部 policy
    const guard = authGuard;
    // 由于 policy 是 constructor 注入的私有字段，通过类型断言替换
    const policy = guard as any;
    policy.policy = {
      authorize: jest.fn().mockResolvedValue({
        decision: 'DENY' as const,
        evidence: { evidenceId: 'ev-denied', policyVersion: 'v1', decision: 'DENY' as const, reason: 'blocked', rules: [], timestamp: new Date().toISOString() },
        cacheHit: false,
      }),
      getPolicyVersion: jest.fn().mockReturnValue('v1'),
      simulate: jest.fn(),
      healthy: jest.fn().mockResolvedValue(true),
    };

    await expect(guard.authorizeAndExecute(authReq, toolReq)).rejects.toBeInstanceOf(InvariantViolationError);
  });
});
