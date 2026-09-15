import { Test } from '@nestjs/testing';
import { BlackboardService } from '@aegisci/domain/orchestration';
import { BlackboardCommunicationGuard } from './blackboard-communication.guard';
import { InvariantViolationError } from './invariant-violation.error';

/**
 * 内核不变量 3 守护测试：AGENT_COMMUNICATION_VIA_BLACKBOARD
 * （Agent 间通信必走 Blackboard，禁止直接调用/读取他人 AgentContext）。违反即 CI 挂红。
 */
describe('BlackboardCommunicationGuard (invariant 3: AGENT_COMMUNICATION_VIA_BLACKBOARD)', () => {
  let guard: BlackboardCommunicationGuard;
  let appendMock: jest.Mock;

  const blackboardCmd = {
    runId: 'run-1',
    entryType: 'conclusion' as const,
    traceSpanId: 'span-1',
    payload: {
      summary: 'review passed',
      evidenceRef: [],
      confidence: 0.9,
      tags: [],
      severity: 'info' as const,
    },
  };

  beforeEach(async () => {
    appendMock = jest.fn().mockResolvedValue({
      entryId: 'bb-1',
      appended: true,
      event: {},
    });
    const moduleRef = await Test.createTestingModule({
      providers: [
        BlackboardCommunicationGuard,
        { provide: BlackboardService, useValue: { append: appendMock } },
      ],
    }).compile();
    guard = moduleRef.get(BlackboardCommunicationGuard);
  });

  it('blocks a direct agent-to-agent call', async () => {
    await expect(
      guard.attemptDirectAgentCall('agent-1', 'agent-2', { hello: true }),
    ).rejects.toBeInstanceOf(InvariantViolationError);
    expect(appendMock).not.toHaveBeenCalled();
  });

  it('allows communication when routed via the blackboard', async () => {
    const result = await guard.communicateViaBlackboard(
      'agent-1',
      blackboardCmd,
      'tenant-1',
      'span-1',
    );
    expect(result.entryId).toBe('bb-1');
    expect(appendMock).toHaveBeenCalledWith(
      'agent-1',
      blackboardCmd,
      'tenant-1',
      'span-1',
    );
  });

  it('assertViaBlackboard() throws when not routed via blackboard', () => {
    expect(() =>
      guard.assertViaBlackboard(false, 'agent-1', 'agent-2'),
    ).toThrow(InvariantViolationError);
  });

  it('assertViaBlackboard() passes when routed via blackboard', () => {
    expect(() => guard.assertViaBlackboard(true, 'agent-1')).not.toThrow();
  });
});
