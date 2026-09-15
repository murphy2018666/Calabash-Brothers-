/**
 * SandboxExecutor —— 一次性容器沙箱执行器 SPI 接口（E3-2）。
 *
 * 设计约束（DES-13.9 + R26 风险应对）：
 * - 只读根文件系统（--read-only）
 * - 无特权模式（--privileged=false）
 * - 无网络出口（--network=none）
 * - 无宿主挂载（--mount=type=tmpfs,target=/tmp）
 * - 每次工具调用启动独立容器，执行完成后销毁
 * - 逃逸检测：privileged/NamespaceEscape/HostPathMount 三类攻击向量
 *
 * 实现策略：
 * - SandboxPodmanExecutor：生产实现（依赖 podman CLI）
 * - StubSandboxExecutor：测试用内存实现（模拟容器生命周期）
 */
import { Injectable, Logger } from '@nestjs/common';

/** 容器运行时类型 */
export type ContainerRuntime = 'podman' | 'docker' | 'stub';

/** 容器启动配置（安全约束） */
export interface SandboxConfig {
  /** 基础镜像（如 alpine:latest、node:20-slim） */
  image: string;
  /** 工作目录（容器内绝对路径） */
  workdir?: string;
  /** 环境变量注入 */
  env?: Record<string, string>;
  /** 超时时间（ms），默认 30s */
  timeoutMs?: number;
  /** 运行时类型 */
  runtime?: ContainerRuntime;
}

/** 容器执行结果 */
export interface SandboxResult {
  /** 是否成功 */
  success: boolean;
  /** 容器 ID（用于审计追溯） */
  containerId: string;
  /** 标准输出 */
  stdout: string;
  /** 标准错误 */
  stderr: string;
  /** 退出码 */
  exitCode: number;
  /** 逃逸检测结果 */
  escapeDetected: boolean;
  /** 逃逸类型（如果检测到） */
  escapeType?: 'privileged' | 'namespace_escape' | 'host_path_mount' | null;
  /** 错误信息（如果有） */
  error?: string;
}

/** 逃逸检测规则 */
export interface EscapeDetectionRule {
  /** 规则名称 */
  name: string;
  /** 检测逻辑：输入命令行参数，返回是否触发逃逸 */
  detect(args: string[]): boolean;
  /** 规则描述 */
  description: string;
}

/** SandboxExecutor SPI 接口 */
export interface SandboxExecutor {
  /** 运行时类型 */
  readonly runtimeType: ContainerRuntime;

  /**
   * 启动一次性容器。
   * @param config 容器配置
   * @returns 容器 ID
   */
  start(config: SandboxConfig): Promise<string>;

  /**
   * 在指定容器中执行命令。
   * @param containerId 容器 ID
   * @param command 要执行的命令
   * @param args 命令参数
   * @returns 执行结果
   */
  exec(containerId: string, command: string, args: string[]): Promise<SandboxResult>;

  /**
   * 销毁容器（执行完成后必须调用）。
   * @param containerId 容器 ID
   */
  destroy(containerId: string): Promise<void>;

  /**
   * 健康检查。
   */
  healthy(): Promise<boolean>;

  /**
   * 注册逃逸检测规则。
   */
  addEscapeRule(rule: EscapeDetectionRule): void;

  /**
   * 列出当前逃逸检测规则。
   */
  getEscapeRules(): EscapeDetectionRule[];
}

/** 默认逃逸检测规则集 */
export const DEFAULT_ESCAPE_RULES: EscapeDetectionRule[] = [
  {
    name: 'privileged-mode',
    description: '拒绝 --privileged 标志',
    detect(args: string[]): boolean {
      return args.includes('--privileged');
    },
  },
  {
    name: 'host-path-mount',
    description: '拒绝 --mount type=bind 宿主路径挂载',
    detect(args: string[]): boolean {
      return args.some((arg) => arg.startsWith('--mount=type=bind'));
    },
  },
  {
    name: 'host-network',
    description: '拒绝 --network=host',
    detect(args: string[]): boolean {
      return args.includes('--network=host');
    },
  },
  {
    name: 'namespace-escape',
    description: '拒绝 --pid=host / --ipc=host / --uts=host',
    detect(args: string[]): boolean {
      return ['--pid=host', '--ipc=host', '--uts=host'].some((flag) => args.includes(flag));
    },
  },
];

/**
 * StubSandboxExecutor —— 测试用内存沙箱实现。
 *
 * 模拟容器生命周期，不依赖真实容器运行时。
 * 用于单元测试和集成测试中的沙箱行为验证。
 */
@Injectable()
export class StubSandboxExecutor implements SandboxExecutor {
  readonly runtimeType: ContainerRuntime = 'stub';
  private readonly logger = new Logger(StubSandboxExecutor.name);
  private readonly containers = new Map<string, { config: SandboxConfig; active: boolean }>();
  private rules: EscapeDetectionRule[] = [...DEFAULT_ESCAPE_RULES];
  private readonly containerIdCounter = { current: 0 };

  async start(config: SandboxConfig): Promise<string> {
    const id = `stub-container-${++this.containerIdCounter.current}`;
    this.containers.set(id, { config, active: true });
    this.logger.debug(`Started stub container: ${id} with image ${config.image}`);
    return id;
  }

  async exec(containerId: string, command: string, args: string[]): Promise<SandboxResult> {
    const container = this.containers.get(containerId);
    if (!container || !container.active) {
      return {
        success: false,
        containerId,
        stdout: '',
        stderr: `Container ${containerId} not found or inactive`,
        exitCode: 1,
        escapeDetected: false,
        escapeType: null,
        error: 'Container not found',
      };
    }

    // 逃逸检测：检查命令参数中是否包含逃逸标志
    const allArgs = [command, ...args];
    const escaped = this.detectEscape(allArgs);

    if (escaped.escapeDetected) {
      this.logger.warn(`Escape detected in container ${containerId}: ${escaped.escapeType}`);
      return {
        success: false,
        containerId,
        stdout: '',
        stderr: `Escape detected: ${escaped.escapeType}`,
        exitCode: 137,
        escapeDetected: true,
        escapeType: escaped.escapeType,
        error: `Escape attempt blocked: ${escaped.escapeType}`,
      };
    }

    // 模拟执行：根据命令返回预设输出
    const mockOutput = this.generateMockOutput(command, args);
    this.logger.debug(`Executed ${command} in container ${containerId}`);

    return {
      success: true,
      containerId,
      stdout: mockOutput.stdout,
      stderr: mockOutput.stderr,
      exitCode: 0,
      escapeDetected: false,
      escapeType: null,
    };
  }

  async destroy(containerId: string): Promise<void> {
    const container = this.containers.get(containerId);
    if (container) {
      container.active = false;
      this.containers.delete(containerId);
      this.logger.debug(`Destroyed stub container: ${containerId}`);
    }
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  addEscapeRule(rule: EscapeDetectionRule): void {
    if (!this.rules.find((r) => r.name === rule.name)) {
      this.rules.push(rule);
    }
  }

  getEscapeRules(): EscapeDetectionRule[] {
    return [...this.rules];
  }

  // ── 私有方法 ──

  private detectEscape(args: string[]): { escapeDetected: boolean; escapeType: 'privileged' | 'namespace_escape' | 'host_path_mount' | null } {
    for (const rule of this.rules) {
      if (rule.detect(args)) {
        switch (rule.name) {
          case 'privileged-mode':
            return { escapeDetected: true, escapeType: 'privileged' };
          case 'namespace-escape':
            return { escapeDetected: true, escapeType: 'namespace_escape' };
          case 'host-path-mount':
            return { escapeDetected: true, escapeType: 'host_path_mount' };
          case 'host-network':
            return { escapeDetected: true, escapeType: 'namespace_escape' };
          default:
            // 未知规则：不报告逃逸类型，但仍视为检测到
            return { escapeDetected: true, escapeType: null };
        }
      }
    }
    return { escapeDetected: false, escapeType: null };
  }

  private generateMockOutput(command: string, args: string[]): { stdout: string; stderr: string } {
    // 模拟常见命令输出
    switch (command) {
      case 'cat': {
        const path = args[0] ?? 'unknown';
        return {
          stdout: `content of ${path}`,
          stderr: '',
        };
      }
      case 'grep': {
        // buildCommand passes ['-n', pattern, path], skip the -n flag
        const patternIdx = args.indexOf('-n') >= 0 ? 1 : 0;
        const pattern = args[patternIdx] ?? '';
        const path = args[args.length - 1] ?? 'unknown';
        return {
          stdout: `pattern:${pattern}\nfile:${path}\nmatch: line 1: example content`,
          stderr: '',
        };
      }
      case 'git': {
        if (args.includes('status')) {
          return { stdout: '## main\nNo files staged\n', stderr: '' };
        }
        if (args.includes('diff')) {
          return { stdout: 'diff --git a/file b/file\n+added line\n', stderr: '' };
        }
        return { stdout: '', stderr: '' };
      }
      case 'ls':
        return { stdout: 'file1.txt\nfile2.ts\nsrc/\n', stderr: '' };
      case 'node': {
        const script = args[0] ?? 'unknown';
        return { stdout: `ran ${script}\n`, stderr: '' };
      }
      default:
        return { stdout: '', stderr: '' };
    }
  }
}
