import type { KernelInvariant } from '@aegisci/core/kernel';

/**
 * InvariantViolationError —— 内核不变量违反（ADD §4 / FR-M7-01 三条内核不变量）。
 *
 * 抛出此错误即视为 CI 架构守护测试（AG 套件）挂红 ——
 * 内核不变量是合规底线，不可被任何插件/路由绕过。
 */
export class InvariantViolationError extends Error {
  constructor(
    public readonly invariant: KernelInvariant,
    message: string,
  ) {
    super(`[${invariant}] ${message}`);
    this.name = 'InvariantViolationError';
    Object.setPrototypeOf(this, InvariantViolationError.prototype);
  }
}
