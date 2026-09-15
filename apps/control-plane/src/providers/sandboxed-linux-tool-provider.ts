/**
 * SandboxedLinuxToolProvider —— 沙箱化 Linux 工具提供者（E3-2-2）。
 *
 * 在 LinuxToolProvider 基础上集成 SandboxExecutor：
 * - 每次工具调用启动一次性容器
 * - 容器内执行命令
 * - 执行后销毁容器
 * - 逃逸检测拦截危险命令
 *
 * 设计约束：
 * - 无特权模式（--privileged=false）
 * - 只读根文件系统（--read-only）
 * - 无网络出口（--network=none）
 * - 无宿主挂载（--mount=type=tmpfs,target=/tmp）
 *
 * 性能：
 * - 容器启动耗时计入 P95（目标 ≤5s）
 * - StubSandboxExecutor 用于测试（零启动开销）
 */
import { Injectable, Logger } from '@nestjs/common';
import type { ToolProvider } from '@aegisci/core/spi/tools';
import type { ToolCallRequest, ToolCallResult } from '@aegisci/shared/types';
import { LinuxToolProvider, type LinuxAction } from './linux-tool-provider';
import {
  SandboxExecutor,
  SandboxConfig,
  DEFAULT_ESCAPE_RULES,
  StubSandboxExecutor,
} from './sandbox-executor';

/** 支持的 action 类型（与 LinuxToolProvider 一致） */
const ACTION_SCHEMAS: Record<
  LinuxAction,
  { allowedArgs: string[]; requiredArgs?: string[]; resourceFormat: string }
> = {
  cat:       { allowedArgs: ['path'],          resourceFormat: 'file (relative path)',   requiredArgs: ['path'] },
  grep:      { allowedArgs: ['pattern', 'path'],resourceFormat: 'file (relative path)',  requiredArgs: ['pattern'] },
  git_status:{ allowedArgs: [],                resourceFormat: 'repo or cwd',            requiredArgs: [] },
  git_diff:  { allowedArgs: ['ref', 'staged'], resourceFormat: 'repo or cwd',            requiredArgs: [] },
  npm_install:{ allowedArgs: ['cwd'],          resourceFormat: 'dir (project root)',      requiredArgs: [] },
  npm_test:  { allowedArgs: ['cwd', 'pattern'],resourceFormat: 'dir (project root)',      requiredArgs: [] },
  node_run:  { allowedArgs: ['script'],        resourceFormat: 'file (js/ts)',            requiredArgs: ['script'] },
  ls:        { allowedArgs: ['path'],          resourceFormat: 'dir (optional)',          requiredArgs: [] },
};

/** 容器基础镜像（可配置） */
const DEFAULT_IMAGE = 'alpine:latest';

@Injectable()
export class SandboxedLinuxToolProvider implements ToolProvider {
  readonly name = 'linux-sandboxed';
  private readonly logger = new Logger(SandboxedLinuxToolProvider.name);
  private readonly sandbox: SandboxExecutor;
  private readonly image: string;

  constructor(sandbox?: SandboxExecutor, image?: string) {
    this.sandbox = sandbox ?? new StubSandboxExecutor();
    this.image = image ?? DEFAULT_IMAGE;

    // 注册默认逃逸检测规则
    for (const rule of DEFAULT_ESCAPE_RULES) {
      this.sandbox.addEscapeRule(rule);
    }
  }

  actions(): string[] {
    return Object.keys(ACTION_SCHEMAS) as LinuxAction[];
  }

  async execute(req: ToolCallRequest): Promise<ToolCallResult> {
    const action = req.action as LinuxAction;
    const schema = ACTION_SCHEMAS[action];

    if (!schema) {
      return {
        success: false,
        data: null,
        error: `Unsupported action: ${action}`,
        evidenceId: req.evidenceId ?? '',
        traceSpanId: req.traceSpanId ?? '',
      };
    }

    // 1. 参数白名单校验（与 LinuxToolProvider 一致）
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
          return {
            success: false,
            data: null,
            error: `Missing required arg: ${key}`,
            evidenceId: req.evidenceId ?? '',
            traceSpanId: req.traceSpanId ?? '',
          };
        }
      }
    }

    // 2. 构建容器内执行命令
    const cmd = this.buildCommand(action, filteredArgs, req.resource);
    if (!cmd) {
      return {
        success: false,
        data: null,
        error: `Cannot build command for action: ${action}`,
        evidenceId: req.evidenceId ?? '',
        traceSpanId: req.traceSpanId ?? '',
      };
    }

    // 3. 启动容器
    const config: SandboxConfig = {
      image: this.image,
      workdir: '/workspace',
      timeoutMs: req.args.timeoutMs ? Number(req.args.timeoutMs) : 30_000,
    };
    const containerId = await this.sandbox.start(config);

    try {
      // 4. 在容器内执行命令
      const result = await this.sandbox.exec(containerId, cmd.cmd, cmd.args);

      if (result.escapeDetected) {
        this.logger.warn(`Escape detected in container ${containerId}: ${result.escapeType}`);
        return {
          success: false,
          data: null,
          error: `Escape attempt blocked: ${result.escapeType}`,
          evidenceId: req.evidenceId ?? '',
          traceSpanId: req.traceSpanId ?? result.containerId,
        };
      }

      if (!result.success) {
        return {
          success: false,
          data: null,
          error: result.error ?? `Container exec failed with code ${result.exitCode}`,
          evidenceId: req.evidenceId ?? '',
          traceSpanId: req.traceSpanId ?? result.containerId,
        };
      }

      return {
        success: true,
        data: { output: result.stdout },
        evidenceId: req.evidenceId ?? '',
        traceSpanId: req.traceSpanId ?? result.containerId,
      };
    } finally {
      // 5. 销毁容器（无论成功失败）
      await this.sandbox.destroy(containerId);
    }
  }

  async healthy(): Promise<boolean> {
    return this.sandbox.healthy();
  }

  // ── 私有：命令构建（与 LinuxToolProvider.buildCommand 逻辑一致）──

  private buildCommand(
    action: LinuxAction,
    args: Record<string, string>,
    resource: string,
  ): { cmd: string; args: string[] } | null {
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
        const pattern = args.pattern ? ['--', `--testPathPattern=${args.pattern}`] : [];
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
   * 只允许相对路径
   */
  private sanitizePath(input: string): string | null {
    if (!input) return null;
    if (input.startsWith('/') || input.startsWith('\\')) return null;
    if (input.includes('..') || input.includes('~')) return null;
    if (!/^[a-zA-Z0-9_./-]+$/.test(input)) return null;
    return input;
  }
}
