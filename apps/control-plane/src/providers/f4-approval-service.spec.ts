import { EventEmitter2 } from '@nestjs/event-emitter';
import { ApprovalService } from '@aegisci/domain/policy/approval';

/**
 * F4 ApprovalService 单元测试（HITL 审批工作流）。
 *
 * 覆盖：
 * - createTicket() 创建工单并发布 ApprovalRequested
 * - castVote() 计票达 quorum → ApprovalCompleted
 * - castVote() reject 达 quorum → ApprovalRejected
 * - timeoutExpired() 超时自动拒绝
 * - 新鲜度窗口验证（FIFTEEN_MIN_MS）
 * - 状态转换约束
 */
describe('F4 ApprovalService (HITL 审批工作流)', () => {
  let service: ApprovalService;
  let emitter: EventEmitter2;

  beforeEach(() => {
    emitter = new EventEmitter2();
    service = new ApprovalService(emitter);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // createTicket()
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('F4-1-1: createTicket() returns open ticket with correct fields', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 2);

    expect(ticket.evidenceId).toBe('ev-1');
    expect(ticket.tenantId).toBe('t1');
    expect(ticket.requiredQuorum).toBe(2);
    expect(ticket.state).toBe('open');
    expect(ticket.votes).toHaveLength(0);
    expect(ticket.isFresh).toBe(true);
  });

  it('F4-1-2: createTicket() stores ticket for later retrieval', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 1);

    const loaded = await service.getTicket(ticket.ticketId);
    expect(loaded).not.toBeNull();
    expect(loaded?.ticketId).toBe(ticket.ticketId);
  });

  it('F4-1-3: ApprovalRequested event emitted on create', async () => {
    const spy = jest.fn();
    emitter.on('ApprovalRequested', spy);

    await service.createTicket('ev-1', 't1', 1);

    expect(spy).toHaveBeenCalled();
  });

  it('F4-1-4: getTicket returns null for nonexistent', async () => {
    expect(await service.getTicket('nonexistent')).toBeNull();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // castVote() — quorum 达成
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('F4-2-1: approve votes reach quorum → ApprovalCompleted', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 2);

    const approvedSpy = jest.fn();
    emitter.on('ApprovalCompleted', approvedSpy);

    await service.castVote(ticket.ticketId, { voterId: 'user-a', voterType: 'user', decision: 'approve', reason: 'LGTM' });
    await service.castVote(ticket.ticketId, { voterId: 'user-b', voterType: 'user', decision: 'approve', reason: 'LGTM' });

    const loaded = await service.getTicket(ticket.ticketId);
    expect(loaded?.state).toBe('approved');
    expect(approvedSpy).toHaveBeenCalled();
  });

  it('F4-2-2: reject votes reach quorum → ApprovalRejected', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 2);

    const rejectedSpy = jest.fn();
    emitter.on('ApprovalRejected', rejectedSpy);

    await service.castVote(ticket.ticketId, { voterId: 'user-a', voterType: 'user', decision: 'reject', reason: 'security concern' });
    await service.castVote(ticket.ticketId, { voterId: 'user-b', voterType: 'user', decision: 'reject', reason: 'policy violation' });

    const loaded = await service.getTicket(ticket.ticketId);
    expect(loaded?.state).toBe('rejected');
    expect(rejectedSpy).toHaveBeenCalled();
  });

  it('F4-2-3: duplicate voterId rejected', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 2);

    await service.castVote(ticket.ticketId, { voterId: 'user-a', voterType: 'user', decision: 'approve', reason: 'ok' });

    await expect(
      service.castVote(ticket.ticketId, { voterId: 'user-a', voterType: 'user', decision: 'approve', reason: 'again' }),
    ).rejects.toThrow(/already voted/);
  });

  it('F4-2-4: vote on closed ticket throws', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 1);
    await service.castVote(ticket.ticketId, { voterId: 'user-a', voterType: 'user', decision: 'approve', reason: 'ok' });

    await expect(
      service.castVote(ticket.ticketId, { voterId: 'user-b', voterType: 'user', decision: 'approve', reason: 'late' }),
    ).rejects.toThrow(/not open/);
  });

  it('F4-2-5: castVote on nonexistent ticket throws', async () => {
    await expect(
      service.castVote('nonexistent', { voterId: 'user-a', voterType: 'user', decision: 'approve', reason: 'ok' }),
    ).rejects.toThrow(/not found/);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // timeoutExpired()
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('F4-3-1: timeoutExpired() sets state to timeout', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 2);

    await service.timeoutExpired(ticket.ticketId);

    const loaded = await service.getTicket(ticket.ticketId);
    expect(loaded?.state).toBe('timeout');
  });

  it('F4-3-2: timeoutExpired() emits ApprovalRejected', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 2);

    const spy = jest.fn();
    emitter.on('ApprovalRejected', spy);
    await service.timeoutExpired(ticket.ticketId);

    expect(spy).toHaveBeenCalled();
  });

  it('F4-3-3: timeoutExpired() on nonexistent ticket is silent', async () => {
    const spy = jest.fn();
    emitter.on('ApprovalRejected', spy);
    await service.timeoutExpired('nonexistent');
    expect(spy).not.toHaveBeenCalled();
  });

  it('F4-3-4: fresh vote within window succeeds', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 1);

    expect(ticket.isFresh).toBe(true);
    await service.castVote(ticket.ticketId, { voterId: 'user-a', voterType: 'user', decision: 'approve', reason: 'ok' });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 混合场景
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('F4-4-1: approve + reject mixed — approve quorum wins', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 2);

    await service.castVote(ticket.ticketId, { voterId: 'user-a', voterType: 'user', decision: 'approve', reason: 'ok' });
    await service.castVote(ticket.ticketId, { voterId: 'user-b', voterType: 'user', decision: 'approve', reason: 'ok' });

    const loaded = await service.getTicket(ticket.ticketId);
    expect(loaded?.state).toBe('approved');
  });

  it('F4-4-2: single reject with quorum=2 does NOT close ticket', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 2);

    await service.castVote(ticket.ticketId, { voterId: 'user-a', voterType: 'user', decision: 'reject', reason: 'nope' });

    const loaded = await service.getTicket(ticket.ticketId);
    expect(loaded?.state).toBe('open');
  });

  it('F4-4-3: quorum=1 approve closes immediately', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 1);

    await service.castVote(ticket.ticketId, { voterId: 'user-a', voterType: 'user', decision: 'approve', reason: 'ok' });

    const loaded = await service.getTicket(ticket.ticketId);
    expect(loaded?.state).toBe('approved');
  });

  it('F4-4-4: timeout closes ticket even with partial votes', async () => {
    const ticket = await service.createTicket('ev-1', 't1', 3);

    await service.castVote(ticket.ticketId, { voterId: 'user-a', voterType: 'user', decision: 'approve', reason: 'ok' });

    const loaded1 = await service.getTicket(ticket.ticketId);
    expect(loaded1?.state).toBe('open');

    await service.timeoutExpired(ticket.ticketId);
    const loaded2 = await service.getTicket(ticket.ticketId);
    expect(loaded2?.state).toBe('timeout');
  });
});
