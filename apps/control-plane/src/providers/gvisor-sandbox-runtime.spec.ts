/**
 * L5-4: GvisorSandboxRuntime — 测试套件
 */

import { GvisorSandboxRuntime } from './gvisor-sandbox-runtime';
import type { SandboxConfig } from './sandbox-executor';

describe('L5-4: GvisorSandboxRuntime', () => {
  let runtime: GvisorSandboxRuntime;

  beforeEach(() => {
    runtime = new GvisorSandboxRuntime();
  });

  afterEach(async () => {
    // 清理所有容器
    for (const id of [...runtime['containers'].keys()]) {
      await runtime.destroy(id);
    }
  });

  describe('start / exec / destroy', () => {
    it('L5-4-1: start returns container ID', async () => {
      const id = await runtime.start({ image: 'alpine:latest' });
      expect(id).toMatch(/^gvisor-/);
    });

    it('L5-4-2: exec succeeds for valid command', async () => {
      const id = await runtime.start({ image: 'alpine:latest' });
      const result = await runtime.exec(id, 'echo', ['hello']);
      expect(result.success).toBe(true);
      expect(result.exitCode).toBe(0);
      expect(result.escapeDetected).toBe(false);
      await runtime.destroy(id);
    });

    it('L5-4-3: exec fails for non-existent container', async () => {
      const result = await runtime.exec('nonexistent', 'echo', ['hi']);
      expect(result.success).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('L5-4-4: destroy removes container', async () => {
      const id = await runtime.start({ image: 'alpine:latest' });
      await runtime.destroy(id);
      const result = await runtime.exec(id, 'echo', ['hi']);
      expect(result.success).toBe(false);
    });
  });

  describe('escape detection', () => {
    it('L5-4-5: privileged mode triggers escape detection', async () => {
      const id = await runtime.start({ image: 'alpine:latest' });
      const result = await runtime.exec(id, 'runsc', ['--privileged', 'echo', 'pwned']);
      expect(result.escapeDetected).toBe(true);
      expect(result.escapeType).toBe('privileged');
      await runtime.destroy(id);
    });

    it('L5-4-6: host path mount triggers escape detection', async () => {
      const id = await runtime.start({ image: 'alpine:latest' });
      const result = await runtime.exec(id, 'runsc', ['--mount=type=bind,src=/etc,target=/host']);
      expect(result.escapeDetected).toBe(true);
      expect(result.escapeType).toBe('host_path_mount');
      await runtime.destroy(id);
    });

    it('L5-4-7: namespace escape triggers detection', async () => {
      const id = await runtime.start({ image: 'alpine:latest' });
      const result = await runtime.exec(id, 'runsc', ['--pid=host', 'ps']);
      expect(result.escapeDetected).toBe(true);
      expect(result.escapeType).toBe('namespace_escape');
      await runtime.destroy(id);
    });
  });

  describe('healthy', () => {
    it('L5-4-8: healthy returns true (stub)', async () => {
      expect(await runtime.healthy()).toBe(true);
    });
  });

  describe('escape rules', () => {
    it('L5-4-9: addEscapeRule adds new rule', () => {
      runtime.addEscapeRule({
        name: 'custom-rule',
        description: 'Test custom rule',
        detect: () => false,
      });
      const rules = runtime.getEscapeRules();
      expect(rules.find((r) => r.name === 'custom-rule')).toBeDefined();
    });

    it('L5-4-10: addEscapeRule does not duplicate existing rule', () => {
      runtime.addEscapeRule({
        name: 'privileged-mode',
        description: 'Duplicate',
        detect: () => false,
      });
      const rules = runtime.getEscapeRules();
      const privilegedRules = rules.filter((r) => r.name === 'privileged-mode');
      expect(privilegedRules).toHaveLength(1);
    });
  });
});
