/**
 * InMemoryConnectionGateway —— ConnectionGatewayPort 内存桩（D2-5）。
 *
 * 实现 PL 域与 Runner 之间的语言边界（ADR-05），测试中替换真实 Gateway 连接。
 * - dispatchJob：记录派发请求，供测试断言
 * - cancelJob：记录取消请求
 * - healthy：始终返回 true
 */
import { Injectable } from '@nestjs/common';
import type { ConnectionGatewayPort } from '@aegisci/domain/pipeline';

export interface DispatchRecord {
  runId: string;
  jobId: string;
  attempt: number;
  pool: string;
  spec: Record<string, unknown>;
}

export interface CancelRecord {
  runId: string;
  jobId: string;
  reason: string;
}

@Injectable()
export class InMemoryConnectionGateway implements ConnectionGatewayPort {
  readonly dispatched: DispatchRecord[] = [];
  readonly cancelled: CancelRecord[] = [];

  async dispatchJob(params: {
    runId: string;
    jobId: string;
    attempt: number;
    pool: string;
    spec: Record<string, unknown>;
  }): Promise<void> {
    this.dispatched.push({ ...params });
  }

  async cancelJob(params: { runId: string; jobId: string; reason: string }): Promise<void> {
    this.cancelled.push({ ...params });
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  reset(): void {
    this.dispatched.length = 0;
    this.cancelled.length = 0;
  }
}
