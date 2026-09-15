import { Test } from '@nestjs/testing';
import { AuditWormService } from '@aegisci/domain/audit';
import type { AuditEnvelope } from '@aegisci/shared/types';
import { AgentActionAuditGuard } from './agent-action-audit.guard';
import { InvariantViolationError } from './invariant-violation.error';

/**
 * AG-4 审计链守护测试 —— 内核不变量 2：EVERY_AGENT_ACTION_AUDITED
 * （所有 Agent 动作必入 WORM 审计）。违反即 CI 挂红。
 */
describe('AgentActionAuditGuard (invariant 2: EVERY_AGENT_ACTION_AUDITED)', () => {
  let guard: AgentActionAuditGuard;
  let sealMock: jest.Mock;

  const envelope: AuditEnvelope = {
    envelopeId: 'env-1',
    tenantId: 'tenant-1',
    principalId: 'agent-1',
    principalType: 'agent',
    action: 'review.run',
    resource: 'run-1',
    evidenceId: 'ev-1',
    traceSpanId: 'span-1',
    result: 'success',
    timestamp: new Date().toISOString(),
    metadata: {},
  };

  beforeEach(async () => {
    sealMock = jest.fn().mockResolvedValue({
      objectKey: 'audit/tenant-1/2026-09-02/env-1.json',
      sealed: true,
      contentHash: 'abc123',
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        AgentActionAuditGuard,
        { provide: AuditWormService, useValue: { seal: sealMock } },
      ],
    }).compile();
    guard = moduleRef.get(AgentActionAuditGuard);
  });

  it('throws InvariantViolationError when an agent action is NOT sealed', async () => {
    await expect(
      guard.runAction('act-1', async () => 'done'),
    ).rejects.toBeInstanceOf(InvariantViolationError);
  });

  it('succeeds when the action is sealed via the WORM audit', async () => {
    await guard.seal('act-1', envelope);
    const result = await guard.runAction('act-1', async () => 'done');
    expect(result).toBe('done');
    expect(sealMock).toHaveBeenCalledWith(envelope);
  });

  it('recordSeal() also satisfies the invariant (external sealing path)', async () => {
    guard.recordSeal('act-2');
    const result = await guard.runAction('act-2', async () => 42);
    expect(result).toBe(42);
  });
});
