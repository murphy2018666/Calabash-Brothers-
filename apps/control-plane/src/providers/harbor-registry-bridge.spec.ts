/**
 * K8b-2: Harbor Registry Bridge — 测试套件
 */

import { HarborRegistryBridge, type HarborBridgeConfig } from './harbor-registry-bridge';

const TEST_CONFIG: HarborBridgeConfig = {
  url: 'https://harbor.aegisci.local',
  username: 'admin',
  password: 'Harbor12345',
  project: 'skills',
};

describe('K8b-2: HarborRegistryBridge', () => {
  let bridge: HarborRegistryBridge;

  beforeEach(() => {
    bridge = new HarborRegistryBridge(TEST_CONFIG);
  });

  afterEach(() => {
    bridge.clear();
  });

  describe('push', () => {
    it('K8b-2-1: push records artifact', async () => {
      const result = await bridge.push('test-skill', '1.0.0', 'sha256:abc123');
      expect(result.ok).toBe(true);
      expect(result.skillId).toBe('test-skill');
      expect(result.digest).toBe('sha256:abc123');
      expect(result.errors).toHaveLength(0);
    });

    it('K8b-2-2: multiple pushes to same skill accumulate', async () => {
      await bridge.push('skill-a', '1.0.0', 'sha256:aaa');
      await bridge.push('skill-a', '1.1.0', 'sha256:bbb');
      const pullResult = await bridge.pull('skill-a');
      expect(pullResult.artifacts).toHaveLength(2);
      expect(pullResult.tags).toHaveLength(2);
    });
  });

  describe('pull', () => {
    it('K8b-2-3: pull returns artifacts for registered skill', async () => {
      await bridge.push('skill-x', '2.0.0', 'sha256:xyz');
      const result = await bridge.pull('skill-x');
      expect(result.ok).toBe(true);
      expect(result.artifacts).toHaveLength(1);
      expect(result.artifacts[0].reference).toBe('skill-x:2.0.0');
    });

    it('K8b-2-4: pull returns empty for unregistered skill', async () => {
      const result = await bridge.pull('nonexistent');
      expect(result.ok).toBe(true);
      expect(result.artifacts).toHaveLength(0);
    });
  });

  describe('list / search', () => {
    it('K8b-2-5: list returns all artifacts in project', async () => {
      await bridge.push('skill-a', '1.0.0', 'sha256:aaa');
      await bridge.push('skill-b', '1.0.0', 'sha256:bbb');
      const all = await bridge.list();
      expect(all).toHaveLength(2);
    });

    it('K8b-2-6: search filters by name', async () => {
      await bridge.push('k8s-rollout', '1.0.0', 'sha256:aaa');
      await bridge.push('gitlab-connector', '1.0.0', 'sha256:bbb');
      const results = await bridge.search('k8s');
      expect(results).toHaveLength(1);
      expect(results[0].reference).toBe('k8s-rollout:1.0.0');
    });
  });

  describe('authentication', () => {
    it('K8b-2-7: getAuthToken returns non-empty token', () => {
      const token = bridge.getAuthToken();
      expect(token).toBeTruthy();
      expect(token.startsWith('harbor_token_')).toBe(true);
    });

    it('K8b-2-8: getBasicAuthHeader returns valid Basic auth', () => {
      const header = bridge.getBasicAuthHeader();
      expect(header.startsWith('Basic ')).toBe(true);
      const decoded = Buffer.from(header.slice(6), 'base64').toString();
      expect(decoded).toContain('admin');
    });
  });

  describe('project isolation', () => {
    it('K8b-2-9: different projects have isolated artifacts', async () => {
      const bridgeA = new HarborRegistryBridge({ ...TEST_CONFIG, project: 'proj-a' });
      const bridgeB = new HarborRegistryBridge({ ...TEST_CONFIG, project: 'proj-b' });
      await bridgeA.push('skill-a', '1.0.0', 'sha256:aaa');
      await bridgeB.push('skill-a', '1.0.0', 'sha256:aaa');
      expect((await bridgeA.list()).length).toBe(1);
      expect((await bridgeB.list()).length).toBe(1);
    });
  });
});
