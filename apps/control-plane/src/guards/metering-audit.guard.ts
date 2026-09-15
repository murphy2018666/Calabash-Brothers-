import { Injectable, Logger } from '@nestjs/common';
import { Principal, ToolCallResult } from '@aegisci/shared/types';
import { MeteringCollectorService } from '../services/metering-collector.service';

/**
 * 计量采集守卫（K10-2）。
 *
 * 在工具调用路径上插入计量采集，fire-and-forget 写入。
 * 失败不影响主链路。
 */
@Injectable()
export class MeteringAuditGuard {
  private readonly logger = new Logger(MeteringAuditGuard.name);

  constructor(private readonly collector: MeteringCollectorService) {}

  /**
   * 在工具调用成功后触发计量采集。
   * @param result 工具调用结果
   * @param principal 调用者身份
   * @param runId 流水号 ID
   */
  async onToolCallSuccess(result: ToolCallResult, principal: Principal, runId: string): Promise<void> {
    // fire-and-forget：不等待结果，不抛出异常
    this.collector.onToolCall(result, principal, runId).catch((err) => {
      this.logger.warn(`metering collection failed for run ${runId}: ${(err as Error).message}`);
    });
  }
}
