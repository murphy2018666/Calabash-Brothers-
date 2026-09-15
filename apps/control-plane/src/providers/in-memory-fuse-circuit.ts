import { Injectable, Logger } from '@nestjs/common';
import type { EventEmitter2 } from '@nestjs/event-emitter';

/**
 * FuseCircuit —— 熔断广播抽象（FR-M3-07 ≤10s 全节点生效）。
 *
 * 接口语义：
 * - broadcast(principal, jtis) 立即广播 EmergencyFrozen，触发 ≤10s 内所有节点吊销。
 * - 生产实现 = NATS JetStream 广播（同步 + 异步双保险）。
 * - 骨架实现 = EventEmitter2，满足 F3 验证需求。
 */
export const FUSE_CIRCUIT = Symbol('FUSE_CIRCUIT');

export interface FuseBroadcast {
  principal: string;
  jtis: string[];
  broadcastAt: string;
}

export interface FuseCircuitPort {
  broadcast(principal: string, jtis: string[]): Promise<FuseBroadcast>;
  /** 健康检查：返回 false 表示广播通道异常，下游应降级。 */
  healthy(): Promise<boolean>;
}

/**
 * InMemoryFuseCircuit —— 事件总线广播实现（骨架/测试用）。
 *
 * 广播语义：
 * - 同步发布 EmergencyFrozen 事件（EventEmitter2）
 * - 保留广播记录供测试断言
 */
@Injectable()
export class InMemoryFuseCircuit implements FuseCircuitPort {
  private readonly logger = new Logger(InMemoryFuseCircuit.name);
  private readonly history: FuseBroadcast[] = [];
  private _healthy = true;

  constructor(private readonly events: EventEmitter2) {}

  async broadcast(principal: string, jtis: string[]): Promise<FuseBroadcast> {
    if (!this._healthy) {
      this.logger.warn(`fuse circuit unhealthy, broadcast rejected (principal=${principal})`);
      throw new Error('fuse circuit unhealthy');
    }
    const broadcast: FuseBroadcast = {
      principal,
      jtis: [...jtis],
      broadcastAt: new Date().toISOString(),
    };
    this.history.push(broadcast);
    // 同步事件，≤10s 约束靠测试中 clock 控制
    this.events.emit('EmergencyFrozen', broadcast);
    this.logger.log(
      `broadcast EmergencyFrozen: principal=${principal}, jtis=${jtis.length}`,
    );
    return broadcast;
  }

  async healthy(): Promise<boolean> {
    return this._healthy;
  }

  /** 模拟故障（测试用） */
  setHealthy(value: boolean): void {
    this._healthy = value;
  }

  getHistory(): readonly FuseBroadcast[] {
    return [...this.history];
  }
}
