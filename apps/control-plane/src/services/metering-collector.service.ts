import { Injectable, Logger } from '@nestjs/common';
import { Principal, ToolCallResult } from '@aegisci/shared/types';
import { MeteringRecord } from '@aegisci/shared/types';
import { BillingEngineService } from './billing-engine.service';
import { PolicyPackExclusiveService } from './policy-pack-exclusive.service';

/**
 * 计量采集服务（K10-2）。
 *
 * 职责：在技能调用完成后采集计量数据并写入 BillingEngine。
 * 失败不阻塞主链路（降级为日志）。
 */
@Injectable()
export class MeteringCollectorService {
  private readonly logger = new Logger(MeteringCollectorService.name);

  constructor(
    private readonly billingEngine: BillingEngineService,
    private readonly exclusivePackService: PolicyPackExclusiveService,
  ) {}

  /**
   * 处理一次工具调用，写入计量记录。
   * fire-and-forget：调用方不等待结果。
   */
  async onToolCall(result: ToolCallResult, principal: Principal, runId: string): Promise<void> {
    try {
      // K19-3: 检查独占包授权
      const packId = result.data?.packId as string | undefined;
      if (packId) {
        const pack = this.exclusivePackService['store'].get(packId);
        if (pack && pack.status === 'published') {
          const isOwner = pack.tenantId === principal.tenantId;
          const isGranted = pack.grantedTenants.includes(principal.tenantId);
          if (!isOwner && !isGranted) {
            this.logger.warn(`unauthorized access to exclusive pack ${packId} by tenant ${principal.tenantId}`);
            return;
          }
        }
      }

      // 构建计量记录
      const record: MeteringRecord = {
        recordId: `meter_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        tenantId: principal.tenantId,
        skillId: result.data?.skillId ?? 'unknown',
        callAt: new Date().toISOString(),
        durationMs: 1, // stub: production 从 TraceContext 获取
        cost: 0, // stub: production 由 BillingEngine.calcCost 计算
        usageType: 'tool',
        evidenceId: result.evidenceId,
        traceSpanId: result.traceSpanId,
      };

      // 幂等写入
      this.billingEngine.recordCall(record);
    } catch (err) {
      // 降级：只记日志，不影响主链路
      this.logger.warn(`metering collection failed: ${(err as Error).message}`);
    }
  }
}
