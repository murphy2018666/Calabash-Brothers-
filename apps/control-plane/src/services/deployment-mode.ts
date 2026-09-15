/**
 * 三档部署模式定义（DES-13.9 / FR-M7-15）
 *
 * 档位：
 * - minimal   : 开发/测试环境，零外部依赖
 * - standard  : 生产标准，完整 SPI 实现
 * - hardened  : 高安全，WORM 审计 + OPA + Vault + gVisor
 *
 * 底线三件套（在任何档位不可关闭）：
 * 1. AuditWorm   —— WORM 审计 Sink
 * 2. PolicyEngine —— 策略求值（内核不变量控制器）
 * 3. Blackboard   —— Agent 通信黑板
 */

import type { SPI_TOKENS } from '@aegisci/core/spi';
import { SPI_TOKENS } from '@aegisci/core/spi';
import { KERNEL_INVARIANTS, type KernelInvariant } from '@aegisci/core/kernel';

/** 三档部署模式 */
export type DeploymentMode = 'minimal' | 'standard' | 'hardened';

/** SPI 在档位中的状态 */
export type SpiMode = 'required' | 'optional' | 'forbidden';

/** SPI 配置项（单个 SPI 在某个档位的定义） */
export interface SpiProfileItem {
  /** SPI 令牌 */
  token: symbol | string;
  /** 档位要求：required=必须启用，optional=可选，forbidden=禁止 */
  mode: SpiMode;
  /** 默认实现类名（required 时有效） */
  defaultImplementation?: string;
  /** 描述 */
  description: string;
}

/** 档位配置文件 */
export interface DeploymentProfile {
  /** 档位名称 */
  mode: DeploymentMode;
  /** 档位描述 */
  description: string;
  /** 要求的 SPI（required） */
  requiredSPIs: SpiProfileItem[];
  /** 可选的 SPI */
  optionalSPIs: SpiProfileItem[];
  /** 禁止的 SPI */
  forbiddenSPIs: SpiProfileItem[];
  /** 底线内核不变量（任何档位不可关闭） */
  kernelInvariants: KernelInvariant[];
  /** 底线 SPI 集合（任何档位不可关闭） */
  mandatoryKernelSPIs: (keyof typeof SPI_TOKENS)[];
}

/** 档位切换校验结果 */
export interface ModeSwitchResult {
  /** 是否允许切换 */
  allowed: boolean;
  /** 不允许的原因（如果 allowed=false） */
  reason?: string;
  /** 警告信息（如果存在） */
  warnings?: string[];
}

/**
 * 档位切换审批标记（hardened → 低档位需要审批）
 */
export interface ModeSwitchApproval {
  /** 审批人 */
  approver: string;
  /** 审批理由 */
  reason: string;
  /** 审批时间戳 */
  approvedAt: number;
  /** 审批 ID */
  approvalId: string;
}
