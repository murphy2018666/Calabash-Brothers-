/**
 * L5-4: GvisorSandboxRuntime —— gVisor 容器运行时沙箱（V1.5）
 *
 * 对应 WBS: L5 其他 SPI 可插拔实现（1.9.5）
 * 对应风险: R36 gVisor 与内核版本不兼容
 *
 * 不变量（DES-13.9 / R13 容器逃逸）：
 * - 只读根文件系统（--read-only）
 * - 无特权模式（--privileged=false）
 * - 无网络出口（--network=none）
 * - 无宿主挂载（--mount=type=tmpfs,target=/tmp）
 * - 每次工具调用启动独立容器，执行完成后销毁
 */

import { randomUUID } from 'crypto';
import type { SandboxExecutor, SandboxConfig, SandboxResult, EscapeDetectionRule } from './sandbox-executor';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** gVisor 配置 */
export interface GvisorConfig {
  /** gVisor runtime 路径，默认 runsc */
  runtimePath?: string;
  /** 基础镜像 */
  baseImage?: string;
  /** 超时时间（ms），默认 30s */
  timeoutMs?: number;
  /** 是否启用内存限制（MB），默认 256 */
  memoryLimitMb?: number;
  /** 是否启用 CPU 限制（核数），默认 1 */
  cpuLimit?: number;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 实现
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * GvisorSandboxRuntime —— gVisor 容器运行时沙箱。
 *
 * DCR-17-03：V1.5 使用 stub 实现，V2.0 对接真实 runsc。
 *
 * 安全约束（R13 / DES-13.9）：
 * - 拒绝 privileged 模式 → 触发逃逸检测
 * - 拒绝宿主路径挂载 → 触发逃逸检测
 * - 拒绝 host network → 触发逃逸检测
 */
export class GvisorSandboxRuntime implements SandboxExecutor {
  readonly runtimeType: 'gvisor' = 'gvisor';
  private readonly config: Required<GvisorConfig>;
  private readonly containers = new Map<string, { active: boolean; startTime: number }>();
  private rules: EscapeDetectionRule[] = [];
  private readonly containerCounter = { current: 0 };

  constructor(config: GvisorConfig = {}) {
    this.config = {
      runtimePath: config.runtimePath ?? 'runsc',
      baseImage: config.baseImage ?? 'alpine:3.19',
      timeoutMs: config.timeoutMs ?? 30000,
      memoryLimitMb: config.memoryLimitMb ?? 256,
      cpuLimit: config.cpuLimit ?? 1,
    };
    // 注册默认逃逸检测规则
    this.rules = [
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
          return args.some((a) => a.startsWith('--mount=type=bind'));
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
          return ['--pid=host', '--ipc=host', '--uts=host'].some((f) => args.includes(f));
        },
      },
    ];
  }

  async start(config: SandboxConfig): Promise<string> {
    const id = `gvisor-${++this.containerCounter.current}-${randomUUID().slice(0, 8)}`;
    this.containers.set(id, { active: true, startTime: Date.now() });
    console.log(`[GvisorSandboxRuntime] started ${id} image=${config.image ?? this.config.baseImage}`);
    return id;
  }

  async exec(containerId: string, command: string, args: string[]): Promise<SandboxResult> {
    const container = this.containers.get(containerId);
    if (!container || !container.active) {
      return this.failResult(containerId, 'Container not found or inactive');
    }

    // 构建 runsc 命令行参数
    const allArgs = [command, ...args];

    // 逃逸检测
    const escaped = this.detectEscape(allArgs);
    if (escaped.escapeDetected) {
      return this.failResult(containerId, `Escape detected: ${escaped.escapeType}`, escaped.escapeDetected, escaped.escapeType);
    }

    // 超时检测
    const elapsed = Date.now() - container.startTime;
    if (elapsed > this.config.timeoutMs) {
      return this.failResult(containerId, `Timeout exceeded (${this.config.timeoutMs}ms)`);
    }

    // Stub: 模拟执行结果
    console.log(`[GvisorSandboxRuntime] exec ${command} ${allArgs.join(' ')} in ${containerId}`);
    return {
      success: true,
      containerId,
      stdout: `ran ${command}\n`,
      stderr: '',
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
      console.log(`[GvisorSandboxRuntime] destroyed ${containerId}`);
    }
  }

  async healthy(): Promise<boolean> {
    // Stub: 检查 runsc 二进制是否存在
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

  private detectEscape(args: string[]): {
    escapeDetected: boolean;
    escapeType: 'privileged' | 'namespace_escape' | 'host_path_mount' | null;
  } {
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
            return { escapeDetected: true, escapeType: null };
        }
      }
    }
    return { escapeDetected: false, escapeType: null };
  }

  private failResult(
    containerId: string,
    error: string,
    escapeDetected = false,
    escapeType: 'privileged' | 'namespace_escape' | 'host_path_mount' | null = null,
  ): SandboxResult {
    return {
      success: false,
      containerId,
      stdout: '',
      stderr: error,
      exitCode: 137,
      escapeDetected,
      escapeType,
      error,
    };
  }
}
