import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import type { ToolProvider } from '@aegisci/core/spi/tools';
import type { ToolCallRequest, ToolCallResult } from '@aegisci/shared/types';

/**
 * InMemoryToolProvider —— 默认 ACI 工具实现（V1.0 默认，SPI 实现）。
 *
 * 不变量（DES-13.9 安全交叉保证）：
 * - 工具只实现 execute()，前置链路（ACI→Policy→Vault→Sandbox）在内核。
 * - 四步执行链不可跳过：authorize → evidence → credential → sandbox。
 *
 * 当前实现：单个 'echo' 工具，回显参数（占位 evidence/trace）。
 */
@Injectable()
export class InMemoryToolProvider implements ToolProvider {
  readonly name = 'echo';

  actions(): string[] {
    return ['echo'];
  }

  async execute(req: ToolCallRequest): Promise<ToolCallResult> {
    return {
      success: true,
      data: { echoed: req.args, action: req.action, resource: req.resource },
      evidenceId: randomUUID(),
      traceSpanId: `span_${randomUUID()}`,
    };
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}
