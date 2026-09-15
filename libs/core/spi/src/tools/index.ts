import type { ToolCallRequest, ToolCallResult } from '@aegisci/shared/types';

/**
 * ToolProvider SPI —— ACI 工具实现
 *
 * 不变量（DES-13.9 安全交叉保证）：
 * - 工具只实现 execute()，前置链路（ACI→Policy→Vault→Sandbox）在内核
 * - 四步执行链不可跳过：authorize → evidence → credential → sandbox
 * - 切换实现不改内核代码（FR-M7-08）
 */
export interface ToolProvider {
  /** 工具名称 */
  readonly name: string;

  /** 列出该工具支持的动作 */
  actions(): string[];

  /** 执行工具调用 —— 内核在调用前已完成 authorize，此处只执行 */
  execute(req: ToolCallRequest): Promise<ToolCallResult>;

  /** 健康检查 */
  healthy(): Promise<boolean>;
}
