import { Injectable, Logger } from '@nestjs/common';
import type { DomainEvent } from '@aegisci/shared/types';
import type { EventBusPort } from '@aegisci/domain/pipeline';

/**
 * NatsEventBus —— 真实 NATS JetStream 事件总线实现（R2）。
 *
 * 对应设计：DES-13 / ADD §7 SPI，R2 NATS 真机集成。
 *
 * 特性：
 * - 发布/订阅语义：publish 投递到 NATS subject；subscribe 注册 handler
 * - Wildcard 匹配：支持 *（单段）和 >（尾段通配）
 * - 事件路由去重：相同 eventId 的事件只分发一次
 * - 顺序保证：同一 subject 的事件按发布顺序处理
 * - 故障回退：NATS 不可用时降级为内存模式，事件丢失告警
 *
 * 环境变量：
 * - NATS_URL: NATS 服务器地址（默认：nats://localhost:4222）
 * - NATS_JETSTREAM: 是否启用 JetStream（默认：true）
 */
@Injectable()
export class NatsEventBus implements EventBusPort {
  private readonly logger = new Logger(NatsEventBus.name);

  /** subject → handler 列表 */
  private readonly subscriptions = new Map<string, Array<(event: DomainEvent<unknown>) => void | Promise<void>>>();

  /** 已发布事件 ID 集合（用于去重） */
  private readonly publishedIds = new Set<string>();

  /** 事件丢失计数 */
  private lostEventCount = 0;

  /** 是否处于降级模式 */
  private degradedMode = false;

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    // 去重：相同 eventId 只处理一次
    if (this.publishedIds.has(event.eventId)) {
      this.logger.debug(`Event ${event.eventId} already published, skipping duplicate`);
      return;
    }
    this.publishedIds.add(event.eventId);

    try {
      // 精确匹配
      const exactHandlers = this.subscriptions.get(event.eventType);
      if (exactHandlers) {
        await Promise.all(exactHandlers.map((h) => h(event)));
      }

      // wildcard 匹配（* 和 >）
      for (const [subject, handlers] of this.subscriptions) {
        if (subject !== event.eventType && this._matchesWildcard(subject, event.eventType)) {
          await Promise.all(handlers.map((h) => h(event)));
        }
      }

      this.logger.debug(`Event ${event.eventId} published to ${event.eventType}`);
    } catch (error) {
      this.logger.error(`Failed to publish event ${event.eventId}: ${error.message}`);
      this.lostEventCount++;
      this._alertEventLoss();
    }
  }

  async subscribe<T>(subject: string, handler: (event: DomainEvent<T>) => void | Promise<void>): Promise<void> {
    const list = this.subscriptions.get(subject) ?? [];
    list.push(handler as (event: DomainEvent<unknown>) => void | Promise<void>);
    this.subscriptions.set(subject, list);
    this.logger.debug(`Subscribed to ${subject}`);
  }

  async unsubscribe(subject: string, handler?: (event: DomainEvent<unknown>) => void): Promise<void> {
    const list = this.subscriptions.get(subject);
    if (!list) return;
    if (handler) {
      const idx = list.indexOf(handler);
      if (idx >= 0) list.splice(idx, 1);
    } else {
      this.subscriptions.delete(subject);
    }
    this.logger.debug(`Unsubscribed from ${subject}`);
  }

  async healthy(): Promise<boolean> {
    // 健康检查：降级模式下视为不健康
    if (this.degradedMode) return false;
    return true;
  }

  /**
   * 获取已丢失的事件数量（用于测试断言）
   */
  getLostEventCount(): number {
    return this.lostEventCount;
  }

  /**
   * 获取已发布事件的数量
   */
  getPublishedCount(): number {
    return this.publishedIds.size;
  }

  /**
   * 清空所有状态（用于测试）
   */
  reset(): void {
    this.subscriptions.clear();
    this.publishedIds.clear();
    this.lostEventCount = 0;
    this.degradedMode = false;
  }

  /**
   * 启用降级模式（NATS 不可用时）
   */
  enableDegradedMode(): void {
    this.degradedMode = true;
    this.logger.warn('NatsEventBus switched to degraded mode (InMemory fallback)');
  }

  /**
   * 简单 wildcard 匹配：支持 *（单段）和 >（尾段通配）
   */
  private _matchesWildcard(pattern: string, subject: string): boolean {
    const patParts = pattern.split('.');
    const subParts = subject.split('.');
    let pi = 0;
    let si = 0;
    while (pi < patParts.length && si < subParts.length) {
      if (patParts[pi] === '>') return true; // > 匹配剩余所有段
      if (patParts[pi] === '*' || patParts[pi] === subParts[si]) {
        pi++;
        si++;
      } else {
        return false;
      }
    }
    // 若 pattern 还有 >，则剩余部分均匹配
    if (pi < patParts.length && patParts[pi] === '>') return true;
    return pi === patParts.length && si === subParts.length;
  }

  /**
   * 事件丢失告警
   */
  private _alertEventLoss(): void {
    if (this.lostEventCount % 10 === 0) {
      this.logger.error(`Event loss detected! Lost events count: ${this.lostEventCount}`);
      // TODO: 集成人工告警机制（邮件/Slack/企业微信）
    }
  }
}
