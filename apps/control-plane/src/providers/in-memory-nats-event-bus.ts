/**
 * InMemoryNatsEventBus —— NATS 事件总线内存桩（D2-5）。
 *
 * 实现 EventBusPort，用于单元测试和集成测试中替换真实 NATS JetStream 连接。
 * 语义：
 * - publish：将事件按 subject 存入 Map，同步转发给所有订阅 handler
 * - subscribe：注册 handler，支持 wildcard subject 匹配（* 和 >）
 * - unsubscribe：移除指定 handler
 * - healthy：始终返回 true（内存实现无外部依赖）
 *
 * 注意：本类不绑定 @Injectable（纯测试桩），由 SpiDefaultsModule 以工厂方式注入。
 */
import type { DomainEvent } from '@aegisci/shared/types';
import type { EventBusPort } from '@aegisci/domain/pipeline';

type Handler<T = unknown> = (event: DomainEvent<T>) => void | Promise<void>;

export class InMemoryNatsEventBus implements EventBusPort {
  /** subject → handler 列表 */
  private readonly subscriptions = new Map<string, Handler[]>();

  /** 已发布事件的记录（供测试断言） */
  readonly published: DomainEvent<unknown>[] = [];

  async publish<T>(event: DomainEvent<T>): Promise<void> {
    this.published.push(event as DomainEvent<unknown>);
    // 精确匹配
    const exact = this.subscriptions.get(event.eventType);
    if (exact) {
      await Promise.all(exact.map((h) => h(event)));
    }
    // wildcard 匹配（* 和 >）
    for (const [subject, handlers] of this.subscriptions) {
      if (subject !== event.eventType && this._matchesWildcard(subject, event.eventType)) {
        await Promise.all(handlers.map((h) => h(event)));
      }
    }
  }

  async subscribe<T>(subject: string, handler: Handler<T>): Promise<void> {
    const list = this.subscriptions.get(subject) ?? [];
    list.push(handler as Handler);
    this.subscriptions.set(subject, list);
  }

  async unsubscribe(subject: string, handler?: Handler<unknown>): Promise<void> {
    const list = this.subscriptions.get(subject);
    if (!list) return;
    if (handler) {
      const idx = list.indexOf(handler as Handler);
      if (idx >= 0) list.splice(idx, 1);
    } else {
      this.subscriptions.delete(subject);
    }
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  /** 清空所有订阅和已发布事件 */
  reset(): void {
    this.subscriptions.clear();
    this.published.length = 0;
  }

  /** 获取某 subject 上的所有 handler（供测试断言） */
  getHandlers(subject: string): Handler[] {
    return this.subscriptions.get(subject) ?? [];
  }

  /** 简单 wildcard 匹配：支持 *（单段）和 >（尾段通配） */
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
}
