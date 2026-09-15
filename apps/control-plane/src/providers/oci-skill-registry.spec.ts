/**
 * K8b-1: OCI Registry 抽象层 — 测试套件
 *
 * 覆盖：
 *  - OciSkillRegistry push/pull/list/register/enable/revoke
 *  - SyncPolicy 加载/校验/合并
 */

import { OciSkillRegistry, type OciRegistryConfig } from './oci-skill-registry';
import {
  loadSyncPolicy,
  validatePolicy,
  DEFAULT_SYNC_POLICY,
  type SyncPolicy,
} from './oci-sync-policy';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试 fixtures
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const TEST_CONFIG: OciRegistryConfig = {
  url: 'https://registry.aegisci.local',
  project: 'skills',
  insecure: true,
};

function makeManifest(overrides: Record<string, unknown> = {}) {
  return {
    name: 'test-skill',
    version: '1.0.0',
    description: 'Test skill',
    author: 'test-author',
    entrypoint: 'entrypoints/test.sh',
    schemaVersion: 1,
    ...overrides,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OciSkillRegistry 测试
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('K8b-1: OciSkillRegistry', () => {
  let registry: OciSkillRegistry;

  beforeEach(() => {
    registry = new OciSkillRegistry(TEST_CONFIG);
  });

  afterEach(() => {
    registry.clear();
  });

  describe('register', () => {
    it('K8b-1-1: valid manifest registers successfully', async () => {
      const manifest = makeManifest();
      const record = await registry.register(manifest, 'sig_valid', 'tenant-a');
      expect(record.skillId).toBe('test-skill');
      expect(record.signatureVerified).toBe(true);
      expect(record.tenantId).toBe('tenant-a');
      expect(record.state).toBe('registered');
    });

    it('K8b-1-2: empty signature sets signatureVerified=false', async () => {
      const manifest = makeManifest();
      const record = await registry.register(manifest, '', 'tenant-a');
      expect(record.signatureVerified).toBe(false);
    });

    it('K8b-1-3: duplicate name@version is idempotent', async () => {
      const manifest = makeManifest();
      const r1 = await registry.register(manifest, 'sig_a', 'tenant-a');
      const r2 = await registry.register(manifest, 'sig_b', 'tenant-a');
      expect(r1).toBe(r2); // 同一对象引用
    });
  });

  describe('get', () => {
    it('K8b-1-4: returns registered skill', async () => {
      const manifest = makeManifest();
      await registry.register(manifest, 'sig', 'tenant-a');
      const record = await registry.get('test-skill');
      expect(record).not.toBeNull();
      expect(record!.manifest.name).toBe('test-skill');
    });

    it('K8b-1-5: returns null for unregistered skill', async () => {
      const record = await registry.get('nonexistent');
      expect(record).toBeNull();
    });
  });

  describe('list / listActive', () => {
    it('K8b-1-6: list filters by tenantId', async () => {
      const m1 = makeManifest({ name: 'skill-a' });
      const m2 = makeManifest({ name: 'skill-b' });
      await registry.register(m1, 'sig', 'tenant-a');
      await registry.register(m2, 'sig', 'tenant-b');

      const listA = await registry.list('tenant-a');
      const listB = await registry.list('tenant-b');
      expect(listA).toHaveLength(1);
      expect(listA[0].manifest.name).toBe('skill-a');
      expect(listB).toHaveLength(1);
      expect(listB[0].manifest.name).toBe('skill-b');
    });

    it('K8b-1-7: listActive returns only active skills', async () => {
      const m1 = makeManifest({ name: 'skill-a' });
      const m2 = makeManifest({ name: 'skill-b' });
      await registry.register(m1, 'sig', 'tenant-a');
      await registry.register(m2, 'sig', 'tenant-a');
      await registry.enable('skill-b', 'admin');

      const active = await registry.listActive('tenant-a');
      expect(active).toHaveLength(1);
      expect(active[0].manifest.name).toBe('skill-b');
    });
  });

  describe('enable / revoke', () => {
    it('K8b-1-8: enable changes state to active', async () => {
      const manifest = makeManifest();
      await registry.register(manifest, 'sig', 'tenant-a');
      await registry.enable('test-skill', 'admin');
      const record = await registry.get('test-skill');
      expect(record!.state).toBe('active');
    });

    it('K8b-1-9: revoke changes state to revoked', async () => {
      const manifest = makeManifest();
      await registry.register(manifest, 'sig', 'tenant-a');
      await registry.enable('test-skill', 'admin');
      await registry.revoke('test-skill');
      const record = await registry.get('test-skill');
      expect(record!.state).toBe('revoked');
    });
  });

  describe('push / pull', () => {
    it('K8b-1-10: push returns ok with valid signature', async () => {
      const manifest = makeManifest();
      const result = await registry.push(manifest, 'sig_valid', 'tenant-a');
      expect(result.ok).toBe(true);
      expect(result.manifestUrl).toContain('test-skill:1.0.0');
      expect(result.errors).toHaveLength(0);
    });

    it('K8b-1-11: push rejects empty signature', async () => {
      const manifest = makeManifest();
      const result = await registry.push(manifest, '', 'tenant-a');
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });
  });

  describe('healthy', () => {
    it('K8b-1-12: healthy returns true (stub)', async () => {
      expect(await registry.healthy()).toBe(true);
    });
  });
});

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SyncPolicy 测试
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('K8b-1: SyncPolicy', () => {
  describe('DEFAULT_SYNC_POLICY', () => {
    it('K8b-1-13: default policy has expected values', () => {
      expect(DEFAULT_SYNC_POLICY.allowedTags).toEqual(['*']);
      expect(DEFAULT_SYNC_POLICY.excludedTenants).toEqual([]);
      expect(DEFAULT_SYNC_POLICY.scheduledSync).toBe(false);
      expect(DEFAULT_SYNC_POLICY.syncIntervalHours).toBe(24);
      expect(DEFAULT_SYNC_POLICY.enabled).toBe(false);
    });
  });

  describe('validatePolicy', () => {
    it('K8b-1-14: valid policy passes validation', () => {
      const policy: SyncPolicy = {
        allowedTags: ['v1.*', 'stable'],
        excludedTenants: ['blocked-tenant'],
        scheduledSync: true,
        syncIntervalHours: 12,
        publicMarketUrl: 'https://public-market.example.com',
        enabled: true,
      };
      expect(() => validatePolicy(policy)).not.toThrow();
    });

    it('K8b-1-15: empty allowedTags throws', () => {
      expect(() =>
        validatePolicy({ ...DEFAULT_SYNC_POLICY, allowedTags: [] }),
      ).toThrow('allowedTags 必须是非空数组');
    });

    it('K8b-1-16: syncIntervalHours out of range throws', () => {
      expect(() =>
        validatePolicy({ ...DEFAULT_SYNC_POLICY, syncIntervalHours: 0 }),
      ).toThrow('syncIntervalHours 必须在 1~168 之间');
      expect(() =>
        validatePolicy({ ...DEFAULT_SYNC_POLICY, syncIntervalHours: 200 }),
      ).toThrow('syncIntervalHours 必须在 1~168 之间');
    });

    it('K8b-1-17: enabled=true without publicMarketUrl throws', () => {
      expect(() =>
        validatePolicy({ ...DEFAULT_SYNC_POLICY, enabled: true, publicMarketUrl: '' }),
      ).toThrow('publicMarketUrl');
    });
  });

  describe('loadSyncPolicy', () => {
    it('K8b-1-18: returns default when file does not exist', () => {
      // 确保 AEGISCI_SYNC_POLICY 未设置
      const original = process.env.AEGISCI_SYNC_POLICY;
      delete process.env.AEGISCI_SYNC_POLICY;
      try {
        const policy = loadSyncPolicy();
        expect(policy).toBeDefined();
        expect(policy.allowedTags).toEqual(['*']);
      } finally {
        if (original !== undefined) {
          process.env.AEGISCI_SYNC_POLICY = original;
        }
      }
    });

    it('K8b-1-19: envOverrides merge into default policy', () => {
      const policy = loadSyncPolicy({
        allowedTags: ['custom-tag'],
        syncIntervalHours: 6,
      });
      expect(policy.allowedTags).toEqual(['custom-tag']);
      expect(policy.syncIntervalHours).toBe(6);
    });
  });
});
