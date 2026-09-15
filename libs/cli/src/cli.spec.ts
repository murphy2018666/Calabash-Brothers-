/**
 * K7-4 · CLI 单元测试
 *
 * 直接测试 skill 命令的行为，通过 Commander v4 内部事件机制绕过 parse() 行为问题。
 */

import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { registerSkillCommands } from './commands/skill';
import { Command } from 'commander';

describe('CLI Skill Commands (K7-4)', () => {
  let tmpDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aegisci-test-'));
    originalCwd = process.cwd();
    process.chdir(tmpDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    // 清理所有 spy，包括 process.exit
    jest.restoreAllMocks();
  });

  function getSkillCmd(): any {
    const program = new Command();
    registerSkillCommands(program);
    const skillCmd = program.commands.find((c: any) => c._name === 'skill');
    expect(skillCmd).toBeDefined();
    return skillCmd;
  }

  function triggerCommandAction(
    skillCmd: any,
    subcmdName: string,
    positionalArgs: string[] = [],
    optionsOverride: Record<string, any> = {},
  ): void {
    const subCmd = skillCmd.commands.find((c: any) => c._name === subcmdName);
    expect(subCmd).toBeDefined();

    const handler = skillCmd.listeners(`command:${subcmdName}`)[0];
    expect(typeof handler).toBe('function');

    // Commander v4 with _storeOptionsAsProperties=true reads opts from instance properties.
    // Set override values directly on the subCmd instance before calling the handler.
    const originalValues: Record<string, any> = {};
    for (const key of Object.keys(optionsOverride)) {
      originalValues[key] = subCmd[key];
      subCmd[key] = optionsOverride[key];
    }

    try {
      handler(positionalArgs, []);
    } finally {
      for (const key of Object.keys(optionsOverride)) {
        subCmd[key] = originalValues[key];
      }
    }
  }

  async function triggerCommandActionAsync(
    skillCmd: any,
    subcmdName: string,
    positionalArgs: string[] = [],
    optionsOverride: Record<string, any> = {},
  ): Promise<void> {
    const subCmd = skillCmd.commands.find((c: any) => c._name === subcmdName);
    expect(subCmd).toBeDefined();

    const handler = skillCmd.listeners(`command:${subcmdName}`)[0];
    expect(typeof handler).toBe('function');

    const originalValues: Record<string, any> = {};
    for (const key of Object.keys(optionsOverride)) {
      originalValues[key] = subCmd[key];
      subCmd[key] = optionsOverride[key];
    }

    try {
      // Commander v4 does not await async handlers; push result to _actionResults
      handler(positionalArgs, []);
      // Wait for any pending async action results: traverse up to find the root command
      let cmd: any = subCmd;
      while (cmd) {
        if (cmd._actionResults && cmd._actionResults.length > 0) {
          await Promise.all(cmd._actionResults);
          break;
        }
        cmd = cmd.parent;
      }
    } finally {
      for (const key of Object.keys(optionsOverride)) {
        subCmd[key] = originalValues[key];
      }
    }
  }

  it('skill init agent 应生成正确的目录结构和 skill.yaml', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const skillCmd = getSkillCmd();
    triggerCommandAction(skillCmd, 'init', ['my-agent']);

    const skillDir = path.join(tmpDir, 'my-agent');
    expect(fs.existsSync(skillDir)).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'src'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'prompts'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'policies'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'tests'))).toBe(true);

    const manifest = fs.readFileSync(path.join(skillDir, 'skill.yaml'), 'utf-8');
    expect(manifest).toContain('name: my-agent');
    expect(manifest).toContain('type: agent');
    expect(manifest).toContain('version: 1.0.0');
    expect(manifest).toContain('riskTier: G2');

    expect(fs.existsSync(path.join(skillDir, 'src', 'index.ts'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'prompts', 'default.md'))).toBe(true);
    expect(fs.existsSync(path.join(skillDir, 'tests', 'index.spec.ts'))).toBe(true);

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('skill init policy-pack 应生成正确的目录结构', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const skillCmd = getSkillCmd();
    triggerCommandAction(skillCmd, 'init', ['my-policy'], { type: 'policy-pack' });

    const skillDir = path.join(tmpDir, 'my-policy');
    expect(fs.existsSync(skillDir)).toBe(true);
    const manifest = fs.readFileSync(path.join(skillDir, 'skill.yaml'), 'utf-8');
    expect(manifest).toContain('type: policy-pack');

    logSpy.mockRestore();
  });

  it('skill init tool 应包含 tools 子目录', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const skillCmd = getSkillCmd();
    triggerCommandAction(skillCmd, 'init', ['my-tool'], { type: 'tool' });

    const skillDir = path.join(tmpDir, 'my-tool');
    expect(fs.existsSync(path.join(skillDir, 'tools'))).toBe(true);

    logSpy.mockRestore();
  });

  it('skill init 在已存在目录应报错并退出', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as any);

    const existingDir = path.join(tmpDir, 'existing-skill');
    fs.mkdirSync(existingDir, { recursive: true });

    const skillCmd = getSkillCmd();
    triggerCommandAction(skillCmd, 'init', ['existing-skill']);

    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('skill build 应读取 skill.yaml 并输出构建信息', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const skillCmd1 = getSkillCmd();
    triggerCommandAction(skillCmd1, 'init', ['build-test']);

    const skillDir = path.join(tmpDir, 'build-test');

    const skillCmd2 = getSkillCmd();
    triggerCommandAction(skillCmd2, 'build', [skillDir]);

    expect(logSpy).toHaveBeenCalledWith('📦 正在构建技能: build-test@1.0.0');
    expect(logSpy).toHaveBeenCalledWith('✅ 构建完成（stub 模式，未执行真实打包）');

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('skill build 在未找到 skill.yaml 时应报错', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    // process.exit is mocked to throw so we can verify it was called with code 1
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => { throw new Error('exit'); }) as any);

    const emptyDir = path.join(tmpDir, 'empty-dir');
    fs.mkdirSync(emptyDir, { recursive: true });

    const skillCmd = getSkillCmd();
    expect(() => triggerCommandAction(skillCmd, 'build', [emptyDir])).toThrow('exit');

    expect(errSpy).toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);

    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it('skill push 应触发 7 步评审并输出推送信息（gate 未通过时抛出异常）', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // init 创建一个可用的 skill.yaml
    const skillCmd1 = getSkillCmd();
    triggerCommandAction(skillCmd1, 'init', ['push-test']);

    const skillDir = path.join(tmpDir, 'push-test');

    const skillCmd2 = getSkillCmd();
    let caughtError: any = null;
    try {
      await triggerCommandActionAsync(skillCmd2, 'push', [skillDir]);
    } catch (e: any) {
      caughtError = e;
    }

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('🔍 评审前检测'));
    // compliance gate 因 coverage 未达标而失败，输出失败日志
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('评审未通过'));
    // 评审失败时抛出异常而非调用 process.exit
    expect(caughtError).toBeInstanceOf(Error);
    expect(caughtError!.message).toContain('评审未通过');

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('skill push 在未找到 skill.yaml 时应报错', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const emptyDir = path.join(tmpDir, 'empty-push-dir');
    fs.mkdirSync(emptyDir, { recursive: true });

    const skillCmd = getSkillCmd();
    let caughtError: any = null;
    try {
      await triggerCommandActionAsync(skillCmd, 'push', [emptyDir]);
    } catch (e: any) {
      caughtError = e;
    }

    expect(caughtError).toBeInstanceOf(Error);
    expect(errSpy).toHaveBeenCalled();

    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it('skill enable 应输出生效信息', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const skillCmd = getSkillCmd();
    triggerCommandAction(skillCmd, 'enable', ['skill-001']);

    expect(logSpy).toHaveBeenCalledWith('✅ 技能 skill-001 已激活（stub 模式）');
    expect(logSpy).toHaveBeenCalledWith('   tenantId: default');

    logSpy.mockRestore();
  });

  it('skill pull 应输出拉取信息并创建输出目录', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    const skillCmd = getSkillCmd();
    triggerCommandAction(skillCmd, 'pull', ['my-skill'], {
      output: path.join(tmpDir, 'output'),
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('📥 拉取技能 my-skill@latest'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('✅ pull 完成'));
    expect(fs.existsSync(path.join(tmpDir, 'output'))).toBe(true);

    logSpy.mockRestore();
  });

  it('skill sync 应输出同步信息（策略文件不存在时提示默认策略）', () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    const skillCmd = getSkillCmd();
    triggerCommandAction(skillCmd, 'sync', [], {
      policy: path.join(tmpDir, 'nonexistent-policy.yaml'),
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('🔄 执行同步'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('⚠️  未找到策略文件'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('✅ sync 完成'));

    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
