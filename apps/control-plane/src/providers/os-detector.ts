/**
 * OsDetector —— 跨 OS 抽象层（E3-4）。
 *
 * 检测当前运行 OS，提供 OS 门控能力。
 * - Linux：功能完整（LinuxToolProvider 可用）
 * - macOS：骨架占位（未来实现）
 * - Windows：骨架占位（未来实现，需 Hyper-V 检测，V1.0）
 *
 * 设计依据：
 * - detailed-design §4.5 Linux 沙箱执行
 * - ADD §6 跨 OS 抽象要求（Win/macOS 占位）
 */
import { Injectable, Logger } from '@nestjs/common';
import * as os from 'os';

export type SupportedOs = 'linux' | 'macos' | 'windows';

export interface OsCapability {
  /** OS 类型 */
  os: SupportedOs;
  /** 是否支持沙箱执行（容器/虚拟环境） */
  sandboxSupported: boolean;
  /** 支持的默认工具提供商名称 */
  defaultToolProvider: string;
  /** 是否有未实现的占位功能 */
  placeholder?: boolean;
  /** 占位说明 */
  placeholderNote?: string;
}

@Injectable()
export class OsDetector {
  private readonly logger = new Logger(OsDetector.name);
  private readonly _capability: OsCapability;

  constructor() {
    this._capability = this.detect();
  }

  get capability(): OsCapability {
    return this._capability;
  }

  /**
   * 检查当前 OS 是否支持沙箱执行（LinuxToolProvider 可用）。
   * macOS/Windows 返回 false 并提示骨架占位。
   */
  isSandboxReady(): boolean {
    return this._capability.sandboxSupported;
  }

  /**
   * 检查是否为预期 OS（用于测试断言）。
   */
  isOs(osName: SupportedOs): boolean {
    return this._capability.os === osName;
  }

  private detect(): OsCapability {
    const platform = os.platform();
    switch (platform) {
      case 'linux':
        this.logger.log('Detected Linux — full tool provider support');
        return {
          os: 'linux',
          sandboxSupported: true,
          defaultToolProvider: 'linux',
        };
      case 'darwin':
        this.logger.warn('Detected macOS — sandbox support is placeholder (V1.1)');
        return {
          os: 'macos',
          sandboxSupported: false,
          defaultToolProvider: 'linux', // 骨架复用 Linux
          placeholder: true,
          placeholderNote: 'macOS sandbox (Hyper-V/Docker) not yet implemented; using linux fallback',
        };
      case 'win32':
        this.logger.warn('Detected Windows — sandbox support is placeholder (V1.0 Hyper-V check required)');
        return {
          os: 'windows',
          sandboxSupported: false,
          defaultToolProvider: 'linux', // 骨架复用 Linux
          placeholder: true,
          placeholderNote: 'Windows sandbox requires Hyper-V detection (V1.0); using linux fallback',
        };
      default:
        this.logger.warn(`Unknown OS platform: ${platform} — falling back to linux`);
        return {
          os: 'linux',
          sandboxSupported: true,
          defaultToolProvider: 'linux',
          placeholder: true,
          placeholderNote: `Unknown platform ${platform} — using linux fallback`,
        };
    }
  }
}
