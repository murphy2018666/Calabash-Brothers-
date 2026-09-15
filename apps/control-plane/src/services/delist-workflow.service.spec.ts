import { DelistWorkflowService } from './delist-workflow.service';
import { DelistWarningService } from './delist-warning.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('DelistWorkflowService', () => {
  let service: DelistWorkflowService;
  let delistWarning: DelistWarningService;
  let eventEmitter: EventEmitter2;

  beforeEach(() => {
    delistWarning = new DelistWarningService();
    eventEmitter = { emit: jest.fn() } as unknown as EventEmitter2;
    service = new DelistWorkflowService(delistWarning, eventEmitter);
    service.clear();
    delistWarning.clear();
  });

  // ── startWorkflow ──

  it('creates a new workflow in pending status', () => {
    const wf = service.startWorkflow('t1', 'skill-a', 'both');

    expect(wf.tenantId).toBe('t1');
    expect(wf.skillId).toBe('skill-a');
    expect(wf.reason).toBe('both');
    expect(wf.status).toBe('pending');
    expect(wf.workflowId).toBeTruthy();
    expect(wf.createdAt).toBeTruthy();
  });

  it('is idempotent: returns existing workflow when one is active', () => {
    const wf1 = service.startWorkflow('t1', 'skill-a', 'stale');
    const wf2 = service.startWorkflow('t1', 'skill-a', 'low_quality');

    expect(wf1.workflowId).toBe(wf2.workflowId);
    expect(wf1.reason).toBe('stale');
  });

  it('allows creating a new workflow after previous one is delisted', () => {
    const wf1 = service.startWorkflow('t1', 'skill-a', 'stale');
    service.notifySkillOwner('t1', 'skill-a');
    service.execDelist('t1', 'skill-a');

    const wf2 = service.startWorkflow('t1', 'skill-a', 'low_quality');
    expect(wf2.workflowId).not.toBe(wf1.workflowId);
    expect(wf2.status).toBe('pending');
  });

  // ── notifySkillOwner ──

  it('transitions pending → notification_sent', () => {
    const wf = service.startWorkflow('t1', 'skill-a', 'both');
    const notified = service.notifySkillOwner('t1', 'skill-a');

    expect(notified).not.toBeNull();
    expect(notified!.status).toBe('notification_sent');
    expect(notified!.notificationSentAt).toBeTruthy();
  });

  it('returns null when no active workflow exists', () => {
    const result = service.notifySkillOwner('t1', 'skill-nonexistent');
    expect(result).toBeNull();
  });

  it('does not re-notify an already notified workflow', () => {
    service.startWorkflow('t1', 'skill-a', 'both');
    service.notifySkillOwner('t1', 'skill-a');
    const second = service.notifySkillOwner('t1', 'skill-a');
    expect(second!.status).toBe('notification_sent');
  });

  // ── execDelist ──

  it('transitions notification_sent → delisted', () => {
    service.startWorkflow('t1', 'skill-a', 'both');
    service.notifySkillOwner('t1', 'skill-a');
    const delisted = service.execDelist('t1', 'skill-a');

    expect(delisted).not.toBeNull();
    expect(delisted!.status).toBe('delisted');
    expect(delisted!.delistedAt).toBeTruthy();
  });

  it('blocks delist when status is still pending', () => {
    service.startWorkflow('t1', 'skill-a', 'both');
    const result = service.execDelist('t1', 'skill-a');

    expect(result!.status).toBe('pending');
  });

  // ── cancelWorkflow ──

  it('transitions notification_sent → cancelled', () => {
    service.startWorkflow('t1', 'skill-a', 'both');
    service.notifySkillOwner('t1', 'skill-a');
    const cancelled = service.cancelWorkflow('t1', service.findActiveWorkflow('t1', 'skill-a')!.workflowId, 'false_positive');

    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.cancelledReason).toBe('false_positive');
    expect(cancelled!.cancelledAt).toBeTruthy();
  });

  it('allows cancelling a pending workflow', () => {
    service.startWorkflow('t1', 'skill-a', 'both');
    const wf = service.findActiveWorkflow('t1', 'skill-a');
    const cancelled = service.cancelWorkflow('t1', wf!.workflowId);

    expect(cancelled!.status).toBe('cancelled');
  });

  it('returns null for non-existent workflow', () => {
    const result = service.cancelWorkflow('t1', 'nonexistent-wf', 'reason');
    expect(result).toBeNull();
  });

  // ── listWorkflows ──

  it('lists workflows with tenant filter', () => {
    service.startWorkflow('t1', 'skill-a', 'stale');
    service.startWorkflow('t2', 'skill-a', 'low_quality');

    const t1Workflows = service.listWorkflows('t1');
    expect(t1Workflows).toHaveLength(1);
    expect(t1Workflows[0].tenantId).toBe('t1');
  });

  it('lists workflows with status filter', () => {
    service.startWorkflow('t1', 'skill-a', 'stale');
    service.notifySkillOwner('t1', 'skill-a');

    const pending = service.listWorkflows(undefined, 'pending');
    const sent = service.listWorkflows(undefined, 'notification_sent');
    expect(pending).toHaveLength(0);
    expect(sent).toHaveLength(1);
  });

  // ── triggerAutoDelist ──

  it('triggers auto delist for critical warnings', () => {
    (delistWarning as any).warningStore.set('w1', {
      warningId: 'w1',
      skillId: 'skill-b',
      tenantId: 't1',
      reason: 'both',
      compositeScore: 10,
      generatedAt: new Date().toISOString(),
    });

    const created = service.triggerAutoDelist('t1');

    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created[0].status).toBe('notification_sent');
  });

  it('does not trigger for high compositeScore warnings', () => {
    (delistWarning as any).warningStore.set('w1', {
      warningId: 'w1',
      skillId: 'skill-b',
      tenantId: 't1',
      reason: 'both',
      compositeScore: 50,
      generatedAt: new Date().toISOString(),
    });

    const created = service.triggerAutoDelist('t1');
    expect(created).toHaveLength(0);
  });

  // ── K17-2: 事件发布测试 ──

  it('publishes SkillDelistedEvent on execDelist', () => {
    service.startWorkflow('t1', 'skill-a', 'both');
    service.notifySkillOwner('t1', 'skill-a');
    service.execDelist('t1', 'skill-a');

    expect(eventEmitter.emit).toHaveBeenCalledWith('market.event', expect.objectContaining({
      eventType: 'skill.delisted',
      tenantId: 't1',
      skillId: 'skill-a',
    }));
  });

  it('publishes SkillRestoredEvent on cancelWorkflow', () => {
    service.startWorkflow('t1', 'skill-a', 'both');
    service.notifySkillOwner('t1', 'skill-a');
    service.cancelWorkflow('t1', service.findActiveWorkflow('t1', 'skill-a')!.workflowId, 'false_positive');

    expect(eventEmitter.emit).toHaveBeenCalledWith('market.event', expect.objectContaining({
      eventType: 'skill.restored',
      tenantId: 't1',
      skillId: 'skill-a',
    }));
  });

  it('does not publish event for blocked delist (pending status)', () => {
    service.startWorkflow('t1', 'skill-a', 'both');
    service.execDelist('t1', 'skill-a'); // blocked, stays pending

    expect(eventEmitter.emit).not.toHaveBeenCalledWith('market.event', expect.objectContaining({
      eventType: 'skill.delisted',
    }));
  });

  it('gracefully handles event emission error', () => {
    (eventEmitter.emit as jest.Mock).mockImplementation(() => {
      throw new Error('emit failed');
    });

    service.startWorkflow('t1', 'skill-a', 'both');
    service.notifySkillOwner('t1', 'skill-a');
    // 不应抛出异常
    expect(() => service.execDelist('t1', 'skill-a')).not.toThrow();
  });
});
