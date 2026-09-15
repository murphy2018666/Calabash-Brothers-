/**
 * E3-2-1: SandboxExecutor 单元测试
 *
 * 覆盖：
 * - StubSandboxExecutor 容器生命周期（start/exec/destroy）
 * - 逃逸检测规则（privileged/namespace_escape/host_path_mount）
 * - 默认逃逸规则集完整性
 * - healthy()
 */
import {
  StubSandboxExecutor,
  type SandboxConfig,
  DEFAULT_ESCAPE_RULES,
} from './sandbox-executor';
import type { SandboxResult } from './sandbox-executor';

describe('E3-2-1 StubSandboxExecutor', () => {
  let executor: StubSandboxExecutor;

  beforeEach(() => {
    executor = new StubSandboxExecutor();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 基础属性
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('runtimeType is stub', () => {
    expect(executor.runtimeType).toBe('stub');
  });

  it('has 4 default escape rules', () => {
    const rules = executor.getEscapeRules();
    expect(rules).toHaveLength(4);
    expect(rules.map((r) => r.name)).toEqual(
      expect.arrayContaining(['privileged-mode', 'host-path-mount', 'host-network', 'namespace-escape']),
    );
  });

  it('healthy() returns true', async () => {
    expect(await executor.healthy()).toBe(true);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 容器生命周期
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('start creates a container with valid ID', async () => {
    const config: SandboxConfig = { image: 'alpine:latest' };
    const containerId = await executor.start(config);

    expect(containerId).toMatch(/^stub-container-\d+$/);
  });

  it('exec returns mock output for known commands', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'ls', []);

    expect(result.success).toBe(true);
    expect(result.stdout).toBeTruthy();
    expect(result.exitCode).toBe(0);
    expect(result.escapeDetected).toBe(false);
  });

  it('exec returns error for unknown command', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    // unknown command with no special handling
    const result = await executor.exec(containerId, 'unknown_cmd', []);

    expect(result.success).toBe(true); // stub 对未知命令也返回 success（空输出）
    expect(result.stdout).toBe('');
  });

  it('exec returns error when container not found', async () => {
    const result = await executor.exec('nonexistent-container', 'ls', []);

    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });

  it('destroy removes container', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    await executor.destroy(containerId);

    const result = await executor.exec(containerId, 'ls', []);
    expect(result.success).toBe(false);
  });

  it('round-trip: start → exec → destroy', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'cat', ['file.txt']);
    await executor.destroy(containerId);

    expect(result.success).toBe(true);
    expect(result.containerId).toBe(containerId);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // cat 命令模拟输出
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('cat command returns mock content', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'cat', ['README.md']);

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('content of');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // grep 命令模拟输出
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('grep command returns mock match results', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'grep', ['-n', 'pattern', 'file.txt']);

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('pattern:pattern');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // git 命令模拟输出
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('git status returns mock output', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'git', ['status', '--porcelain']);

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('## main');
  });

  it('git diff returns mock output', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'git', ['diff', 'HEAD']);

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('diff --git');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // ls 命令模拟输出
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('ls command returns mock directory listing', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'ls', ['-la']);

    expect(result.success).toBe(true);
    expect(result.stdout).toContain('file1.txt');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 逃逸检测
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('detects privileged mode escape attempt', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'run', ['--privileged', 'echo', 'hello']);

    expect(result.escapeDetected).toBe(true);
    expect(result.escapeType).toBe('privileged');
    expect(result.success).toBe(false);
  });

  it('detects host path mount escape attempt', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'run', ['--mount=type=bind,source=/etc,target=/host_etc', 'echo', 'hello']);

    expect(result.escapeDetected).toBe(true);
    expect(result.escapeType).toBe('host_path_mount');
    expect(result.success).toBe(false);
  });

  it('detects namespace escape attempt (pid=host)', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'run', ['--pid=host', 'echo', 'hello']);

    expect(result.escapeDetected).toBe(true);
    expect(result.escapeType).toBe('namespace_escape');
    expect(result.success).toBe(false);
  });

  it('detects namespace escape attempt (ipc=host)', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'run', ['--ipc=host', 'echo', 'hello']);

    expect(result.escapeDetected).toBe(true);
    expect(result.escapeType).toBe('namespace_escape');
  });

  it('detects namespace escape attempt (uts=host)', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'run', ['--uts=host', 'echo', 'hello']);

    expect(result.escapeDetected).toBe(true);
    expect(result.escapeType).toBe('namespace_escape');
  });

  it('allows normal commands without escape detection', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'cat', ['file.txt']);

    expect(result.escapeDetected).toBe(false);
    expect(result.escapeType).toBeNull();
    expect(result.success).toBe(true);
  });

  it('allows --read-only flag (not an escape vector)', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'run', ['--read-only', 'echo', 'hello']);

    expect(result.escapeDetected).toBe(false);
    expect(result.success).toBe(true);
  });

  it('allows --network=none flag (not an escape vector)', async () => {
    const containerId = await executor.start({ image: 'alpine:latest' });
    const result = await executor.exec(containerId, 'run', ['--network=none', 'echo', 'hello']);

    expect(result.escapeDetected).toBe(false);
    expect(result.success).toBe(true);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 自定义逃逸规则
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('addEscapeRule adds custom rule', () => {
    executor.addEscapeRule({
      name: 'custom-rule',
      description: 'Detects custom escape pattern',
      detect: (args) => args.includes('--custom-escape'),
    });

    const rules = executor.getEscapeRules();
    expect(rules.find((r) => r.name === 'custom-rule')).toBeTruthy();
  });

  it('addEscapeRule does not duplicate existing rule', () => {
    const initialCount = executor.getEscapeRules().length;
    executor.addEscapeRule(DEFAULT_ESCAPE_RULES[0]);
    expect(executor.getEscapeRules().length).toBe(initialCount);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 多容器隔离
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('multiple containers are isolated', async () => {
    const id1 = await executor.start({ image: 'alpine:latest' });
    const id2 = await executor.start({ image: 'node:20-slim' });

    expect(id1).not.toBe(id2);

    const result1 = await executor.exec(id1, 'ls', []);
    const result2 = await executor.exec(id2, 'ls', []);

    expect(result1.success).toBe(true);
    expect(result2.success).toBe(true);

    await executor.destroy(id1);
    await executor.destroy(id2);

    // id1 已销毁，再次 exec 应失败
    const result1After = await executor.exec(id1, 'ls', []);
    expect(result1After.success).toBe(false);
  });
});
