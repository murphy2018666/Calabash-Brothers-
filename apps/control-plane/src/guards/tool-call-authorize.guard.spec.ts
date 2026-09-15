import { Test } from '@nestjs/testing';
import { SPI_TOKENS } from '@aegisci/core/spi';
import type { AuthorizeRequest, ToolCallRequest } from '@aegisci/shared/types';
import { EmbeddedPolicyEngine } from '../providers/embedded-policy-engine';
import { ToolCallAuthorizeGuard } from './tool-call-authorize.guard';
import { InvariantViolationError } from './invariant-violation.error';

/**
 * AG-3 权限链守护测试 —— 内核不变量 1：EVERY_TOOL_CALL_AUTHORIZE
 * （每次 Agent 工具调用必经 Policy Engine 裁决）。违反即 CI 挂红。
 */
describe('ToolCallAuthorizeGuard (invariant 1: EVERY_TOOL_CALL_AUTHORIZE)', () => {
  const authReq: AuthorizeRequest = {
    principal: {
      id: 'agent-1',
      type: 'agent',
      tenantId: 'tenant-1',
      roles: [],
    },
    action: 'echo',
    resource: 'repo/x',
    context: { env: 'development' },
  };
  const toolReq: ToolCallRequest = {
    toolName: 'echo',
    action: 'echo',
    resource: 'repo/x',
    args: { msg: 'hi' },
    agentId: 'agent-1',
    runId: 'run-1',
  };

  describe('with an ALLOW policy engine', () => {
    let guard: ToolCallAuthorizeGuard;
    let toolExecute: jest.Mock;

    beforeEach(async () => {
      toolExecute = jest.fn().mockResolvedValue({
        success: true,
        data: 'ok',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      });
      const allowEngine = {
        authorize: jest.fn().mockResolvedValue({
          decision: 'ALLOW',
          evidence: {
            evidenceId: 'ev-1',
            policyVersion: 'v0',
            decision: 'ALLOW' as const,
            reason: 'ok',
            rules: [],
            timestamp: new Date().toISOString(),
          },
          cacheHit: false,
        }),
        getPolicyVersion: jest.fn().mockReturnValue('v0'),
        simulate: jest.fn(),
        healthy: jest.fn().mockResolvedValue(true),
      };
      const mockTool = {
        name: 'echo',
        actions: jest.fn().mockReturnValue(['echo']),
        execute: toolExecute,
        healthy: jest.fn().mockResolvedValue(true),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          ToolCallAuthorizeGuard,
          { provide: SPI_TOKENS.POLICY_ENGINE, useValue: allowEngine },
          { provide: SPI_TOKENS.TOOL_PROVIDER, useValue: mockTool },
        ],
      }).compile();
      guard = moduleRef.get(ToolCallAuthorizeGuard);
    });

    it('throws InvariantViolationError when a tool is called WITHOUT authorize first', async () => {
      await expect(guard.execute(toolReq)).rejects.toBeInstanceOf(
        InvariantViolationError,
      );
      expect(toolExecute).not.toHaveBeenCalled();
    });

    it('succeeds when authorize() is called before execute()', async () => {
      const decision = await guard.authorize(authReq);
      expect(decision.decision).toBe('ALLOW');

      const result = await guard.execute(toolReq);
      expect(result.success).toBe(true);
      expect(toolExecute).toHaveBeenCalledWith(toolReq);
    });

    it('authorizeAndExecute() runs the full authorized chain', async () => {
      const result = await guard.authorizeAndExecute(authReq, toolReq);
      expect(result.success).toBe(true);
      expect(toolExecute).toHaveBeenCalledTimes(1);
    });
  });

  describe('with the default-deny EmbeddedPolicyEngine', () => {
    let guard: ToolCallAuthorizeGuard;
    let toolExecute: jest.Mock;

    beforeEach(async () => {
      toolExecute = jest.fn().mockResolvedValue({
        success: true,
        data: 'ok',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      });
      const mockTool = {
        name: 'echo',
        actions: jest.fn().mockReturnValue(['echo']),
        execute: toolExecute,
        healthy: jest.fn().mockResolvedValue(true),
      };
      const moduleRef = await Test.createTestingModule({
        providers: [
          ToolCallAuthorizeGuard,
          EmbeddedPolicyEngine,
          { provide: SPI_TOKENS.POLICY_ENGINE, useExisting: EmbeddedPolicyEngine },
          { provide: SPI_TOKENS.TOOL_PROVIDER, useValue: mockTool },
        ],
      }).compile();
      guard = moduleRef.get(ToolCallAuthorizeGuard);
    });

    it('authorize() returns DENY by default', async () => {
      const decision = await guard.authorize(authReq);
      expect(decision.decision).toBe('DENY');
    });

    it('execute() still throws after a DENY (deny does not grant authorization)', async () => {
      await guard.authorize(authReq);
      await expect(guard.execute(toolReq)).rejects.toBeInstanceOf(
        InvariantViolationError,
      );
      expect(toolExecute).not.toHaveBeenCalled();
    });

    it('authorizeAndExecute() throws InvariantViolationError on DENY', async () => {
      await expect(
        guard.authorizeAndExecute(authReq, toolReq),
      ).rejects.toBeInstanceOf(InvariantViolationError);
      expect(toolExecute).not.toHaveBeenCalled();
    });
  });
});
