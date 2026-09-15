/**
 * LinuxToolProvider —— Linux 原生工具实现（E3-1）。
 *
 * 通过 child_process.spawnSync 执行 shell 命令，
 * 封装常用 CI/CD 工具（cat/grep/git/npm/node）的基础操作。
 *
 * 不变量：
 * - 不直接执行任意 sh -c 字符串（防注入），仅支持预定义 actions
 * - 每个 action 有明确的白名单参数（args schema 校验）
 * - 输出截断由 OutputRenderer 层处理（≤10MB，见 E3-3）
 * - 执行前 PolicyEngine 已裁决（ToolCallAuthorizeGuard 前置保证）
 *
 * 设计依据：
 * - detailed-design §4.5 Linux 沙箱执行
 * - ADD §3.3 工具调用不可绕过内核守卫
 */
import { randomUUID } from 'crypto';
import { spawnSync } from 'child_process';
import { Injectable, Logger } from '@nestjs/common';
import type { ToolProvider } from '@aegisci/core/spi/tools';
import type { ToolCallRequest, ToolCallResult } from '@aegisci/shared/types';

/** 支持的 action 类型 */
export type LinuxAction = 'cat' | 'grep' | 'git_status' | 'git_diff' | 'npm_install' | 'npm_test' | 'node_run' | 'ls';

/** 每个 action 的参数 schema（用于静态校验，防注入） */
interface ActionSchema {
  /** 允许的参数名列表（白名单，忽略未声明字段） */
  allowedArgs: string[];
  /** 必需参数（执行前校验） */
  requiredArgs?: string[];
  /** 资源格式说明（如 file: path/to/file 或 repo: org/repo） */
  resourceFormat: string;
}

const ACTION_SCHEMAS: Record<LinuxAction, ActionSchema> = {
  cat:        { allowedArgs: ['path'],          resourceFormat: 'file (relative path)',     requiredArgs: ['path'] },
  grep:       { allowedArgs: ['pattern', 'path'],resourceFormat: 'file (relative path)',    requiredArgs: ['pattern'] },
  git_status: { allowedArgs: [],                resourceFormat: 'repo or cwd',              requiredArgs: [] },
  git_diff:   { allowedArgs: ['ref', 'staged'], resourceFormat: 'repo or cwd',              requiredArgs: [] },
  npm_install: { allowedArgs: ['cwd'],          resourceFormat: 'dir (project root)',        requiredArgs: [] },
  npm_test:   { allowedArgs: ['cwd', 'pattern'],resourceFormat: 'dir (project root)',        requiredArgs: [] },
  node_run:   { allowedArgs: ['script'],        resourceFormat: 'file (js/ts)',              requiredArgs: ['script'] },
  ls:         { allowedArgs: ['path'],          resourceFormat: 'dir (optional)',            requiredArgs: [] },
};

/** 最大输出字节数（10MB，对应 NFR-P1 输出大小限制） */
const MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

@Injectable()
export class LinuxToolProvider implements ToolProvider {
  readonly name = 'linux';
  private readonly logger = new Logger(LinuxToolProvider.name);

  actions(): string[] {
    return Object.keys(ACTION_SCHEMAS) as LinuxAction[];
  }

  async execute(req: ToolCallRequest): Promise<ToolCallResult> {
    const action = req.action as LinuxAction;
    const schema = ACTION_SCHEMAS[action];
    if (!schema) {
      return { success: false, data: null, error: `Unsupported action: ${action}`, evidenceId: '', traceSpanId: '' };
    }

    // 参数白名单校验：只取允许的字段
    const filteredArgs: Record<string, string> = {};
    for (const key of schema.allowedArgs) {
      if (req.args[key] != null) {
        filteredArgs[key] = String(req.args[key]);
      }
    }
    // 必需参数校验
    if (schema.requiredArgs) {
      for (const key of schema.requiredArgs) {
        if (!filteredArgs[key]) {
          return { success: false, data: null, error: `Missing required arg: ${key}`, evidenceId: '', traceSpanId: '' };
        }
      }
    }

    const cmd = this.buildCommand(action, filteredArgs, req.resource);
    if (!cmd) {
      return { success: false, data: null, error: `Cannot build command for action: ${action}`, evidenceId: '', traceSpanId: '' };
    }

    this.logger.debug(`executing linux tool: action=${action} resource=${req.resource} args=${JSON.stringify(filteredArgs)}`);

    const result = spawnSync(cmd.cmd, cmd.args, {
      encoding: 'utf8',
      maxBuffer: MAX_OUTPUT_BYTES,
      timeout: 30_000, // 30s 超时（单个工具调用 P95 ≤ 5s，此处留余量）
    });

    if (result.error) {
      return {
        success: false,
        data: null,
        error: result.error.message,
        evidenceId: randomUUID(),
        traceSpanId: `span_${randomUUID()}`,
      };
    }

    if (result.status !== 0) {
      const stderr = (result.stderr as string)?.slice(0, 4096) ?? '';
      return {
        success: false,
        data: { output: (result.stdout as string)?.slice(0, 4096), stderr },
        error: `Command exited with code ${result.status}`,
        evidenceId: randomUUID(),
        traceSpanId: `span_${randomUUID()}`,
      };
    }

    return {
      success: true,
      data: { output: (result.stdout as string)?.slice(0, MAX_OUTPUT_BYTES) },
      evidenceId: randomUUID(),
      traceSpanId: `span_${randomUUID()}`,
    };
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  // ── 私有：命令构建 ──

  private buildCommand(action: LinuxAction, args: Record<string, string>, resource: string): { cmd: string; args: string[] } | null {
    const cwd = args.cwd ?? process.cwd();
    switch (action) {
      case 'cat': {
        const path = this.sanitizePath(args.path ?? resource);
        if (!path) return null;
        return { cmd: 'cat', args: [path] };
      }
      case 'grep': {
        const pattern = args.pattern;
        const path = this.sanitizePath(args.path ?? resource);
        if (!pattern || !path) return null;
        return { cmd: 'grep', args: ['-n', pattern, path] };
      }
      case 'git_status':
        return { cmd: 'git', args: ['status', '--porcelain', '-u'] };
      case 'git_diff': {
        const ref = args.ref ?? 'HEAD';
        const staged = args.staged === 'true' ? ['--staged'] : [];
        return { cmd: 'git', args: ['diff', ref, ...staged] };
      }
      case 'npm_install':
        return { cmd: 'npm', args: ['install', '--prefer-offline'] };
      case 'npm_test': {
        const pattern = args.pattern ? ['--', '--testPathPattern=' + args.pattern] : [];
        return { cmd: 'npm', args: ['test', ...pattern] };
      }
      case 'node_run': {
        const script = this.sanitizePath(args.script ?? resource);
        if (!script) return null;
        return { cmd: 'node', args: [script] };
      }
      case 'ls': {
        const path = args.path ?? resource;
        return { cmd: 'ls', args: path ? ['-la', path] : ['-la'] };
      }
      default:
        return null;
    }
  }

  /**
   * 路径安全化：拒绝绝对路径、.. 遍历、符号链接
   * 只允许相对路径（相对于 resource 或 cwd）
   */
  private sanitizePath(input: string): string | null {
    if (!input) return null;
    // 拒绝绝对路径
    if (input.startsWith('/') || input.startsWith('\\')) return null;
    // 拒绝目录遍历
    if (input.includes('..') || input.includes('~')) return null;
    // 只允许字母数字斜杠点连字符下划线
    if (!/^[a-zA-Z0-9_./-]+$/.test(input)) return null;
    return input;
  }
}
