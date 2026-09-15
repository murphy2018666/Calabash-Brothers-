/**
 * K8b-2: Sync Scheduler — 测试套件
 */

import { SyncScheduler } from './sync-scheduler';
import { DEFAULT_SYNC_POLICY, type SyncPolicy } from './oci-sync-policy';

function makePolicy(overrides: Partial<SyncPolicy> = {}): SyncPolicy {
  return { ...DEFAULT_SYNC_POLICY, ...overrides };
}

describe('K8b-2: SyncScheduler', () => {
  describe('start / stop', () => {
    it('K8b-2-19: start changes status to RUNNING', () => {
      const scheduler = new SyncScheduler(makePolicy({ enabled: true }));
      scheduler.start();
      expect(scheduler.getStatus()).toBe('running');
    });

    it('K8b-2-20: stop changes status to STOPPED', () => {
      const scheduler = new SyncScheduler(makePolicy({ enabled: true }));
      scheduler.start();
      scheduler.stop();
      expect(scheduler.getStatus()).toBe('stopped');
    });

    it('K8b-2-21: start with disabled policy logs warning', () => {
      const scheduler = new SyncScheduler(makePolicy({ enabled: false }));
      scheduler.start();
      // Status should remain IDLE since policy is disabled
      expect(scheduler.getStatus()).toBe('idle');
    });
  });

  describe('execute', () => {
    it('K8b-2-22: execute syncs matching skills', () => {
      const scheduler = new SyncScheduler(makePolicy({ enabled: true, allowedTags: ['v1.*'] }));
      scheduler.addPublicSkill('skill-a', 'v1.0.0', 'tenant-a');
      scheduler.addPublicSkill('skill-b', 'v2.0.0', 'tenant-a');
      const result = scheduler.execute();
      expect(result.skillsSynced).toBe(1); // only v1.* matches
      expect(result.skillsSkipped).toBe(1); // v2.0.0 doesn't match
      expect(result.ok).toBe(true);
    });

    it('K8b-2-23: execute skips excluded tenants', () => {
      const scheduler = new SyncScheduler(
        makePolicy({ enabled: true, excludedTenants: ['blocked-tenant'] }),
      );
      scheduler.addPublicSkill('skill-a', 'v1.0.0', 'blocked-tenant');
      scheduler.addPublicSkill('skill-b', 'v1.0.0', 'good-tenant');
      const result = scheduler.execute();
      expect(result.skillsSynced).toBe(1);
      expect(result.skillsSkipped).toBe(1);
    });

    it('K8b-2-24: execute on stopped scheduler returns failed', () => {
      const scheduler = new SyncScheduler(makePolicy({ enabled: true }));
      scheduler.start();
      scheduler.stop();
      const result = scheduler.execute();
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('K8b-2-25: execute with * wildcard matches all tags', () => {
      const scheduler = new SyncScheduler(makePolicy({ enabled: true, allowedTags: ['*'] }));
      scheduler.addPublicSkill('skill-a', 'v1.0.0', 'tenant-a');
      scheduler.addPublicSkill('skill-b', 'latest', 'tenant-a');
      const result = scheduler.execute();
      expect(result.skillsSynced).toBe(2);
      expect(result.skillsSkipped).toBe(0);
    });
  });

  describe('logs', () => {
    it('K8b-2-26: getLogs returns sync log entries', () => {
      const scheduler = new SyncScheduler(makePolicy({ enabled: true }));
      scheduler.start();
      scheduler.addPublicSkill('skill-a', 'v1.0.0', 'tenant-a');
      scheduler.execute();
      const logs = scheduler.getLogs();
      expect(logs.length).toBeGreaterThan(0);
      expect(logs.some((l) => l.includes('同步完成'))).toBe(true);
    });
  });
});
