/**
 * H2: 连接器完善 — GitLab / GitHub / Jira / Harbor stub 验证
 *
 * 验证四大企业连接器 stub 行为：
 *  - GitLab: 分支匹配、MR 事件、Webhook 校验
 *  - GitHub: PR 事件、push 过滤、signature 校验
 *  - Jira: 工单查询、状态同步、失败重试
 *  - Harbor: 镜像推送、签名验证、仓库管理
 *
 * 对应 WBS: H2 (1.7.2 连接器完善)
 */

import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DomainEvent } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// H2 公共类型
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type ConnectorType = 'gitlab' | 'github' | 'jira' | 'harbor';

export interface ConnectorConfig {
  type: ConnectorType;
  baseUrl: string;
  token: string;
  tenantId: string;
  options?: Record<string, unknown>;
}

export interface ConnectorResult {
  ok: boolean;
  code: number;
  message: string;
  event?: DomainEvent;
}

export interface ConnectorHealth {
  type: ConnectorType;
  ok: boolean;
  latencyMs: number;
  lastSyncAt: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// H2 GitLab 连接器
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class GitLabConnector {
  private readonly logger = new Logger(GitLabConnector.name);
  private readonly config: ConnectorConfig;
  private readonly events: DomainEvent[] = [];
  private readonly webhookSecret: string;

  constructor(config: ConnectorConfig, private readonly emitter: EventEmitter2) {
    this.config = config;
    this.webhookSecret = config.options?.webhookSecret as string ?? '';
  }

  /**
   * dispatchEvent —— 处理 GitLab webhook 事件（push / MR / tag）
   * 验证 webhook 签名后派发标准 DomainEvent
   */
  async dispatchEvent(payload: Record<string, unknown>): Promise<ConnectorResult> {
    const signature = (payload['X-Gitlab-Token'] ?? '') as string;
    if (this.webhookSecret && signature !== this.webhookSecret) {
      return { ok: false, code: 401, message: 'GitLab webhook signature mismatch' };
    }

    const eventType = payload['object_kind'] as string ?? 'push';
    const eventName = eventType === 'merge_request_event' ? 'mr.created'
      : eventType === 'tag_push_event' ? 'tag.pushed'
      : 'push.received';

    const event: DomainEvent = {
      eventType: eventName,
      source: 'gitlab',
      tenantId: this.config.tenantId,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.events.push(event);
    this.emitter.emit(eventName, event);

    this.logger.debug(`[GitLab] dispatchEvent type=${eventType} event=${eventName}`);
    return { ok: true, code: 200, message: `dispatched ${eventName}`, event };
  }

  /**
   * verifySignature —— 验证 GitLab webhook 签名
   * stub 实现：当 webhookSecret 已配置且 payload 携带正确 token 时返回 true
   */
  verifySignature(payload: string, signature: string): boolean {
    if (!this.webhookSecret) return true; // 未配置 secret 时跳过校验（开发环境）
    return signature === this.webhookSecret;
  }

  /**
   * listBranches —— 列出仓库分支（stub）
   */
  async listBranches(projectId: string): Promise<string[]> {
    return [`main`, `develop`, `feature/${projectId}`];
  }

  /**
   * health —— 连接器健康检查
   */
  async health(): Promise<ConnectorHealth> {
    return {
      type: 'gitlab',
      ok: true,
      latencyMs: 5,
      lastSyncAt: new Date().toISOString(),
    };
  }

  getEvents(): DomainEvent[] {
    return this.events;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// H2 GitHub 连接器
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class GitHubConnector {
  private readonly logger = new Logger(GitHubConnector.name);
  private readonly config: ConnectorConfig;
  private readonly events: DomainEvent[] = [];
  private readonly secret: string;

  constructor(config: ConnectorConfig, private readonly emitter: EventEmitter2) {
    this.config = config;
    this.secret = config.options?.secret as string ?? '';
  }

  /**
   * dispatchEvent —— 处理 GitHub webhook 事件（pull_request / push）
   * 验证 X-Hub-Signature 摘要
   */
  async dispatchEvent(payload: Record<string, unknown>): Promise<ConnectorResult> {
    const signature = (payload['X-Hub-Signature'] ?? '') as string;
    if (this.secret && !signature.startsWith('sha256=')) {
      return { ok: false, code: 401, message: 'GitHub webhook signature missing' };
    }

    const action = (payload['action'] ?? 'opened') as string;
    const event = payload['event_type'] as string ?? 'push';
    const eventName = event === 'pull_request' ? `pr.${action}` : 'push.received';

    const domainEvent: DomainEvent = {
      eventType: eventName,
      source: 'github',
      tenantId: this.config.tenantId,
      payload,
      timestamp: new Date().toISOString(),
    };
    this.events.push(domainEvent);
    this.emitter.emit(eventName, domainEvent);

    this.logger.debug(`[GitHub] dispatchEvent event=${eventName} action=${action}`);
    return { ok: true, code: 200, message: `dispatched ${eventName}`, event: domainEvent };
  }

  /**
   * filterPush —— 过滤不相关的 push 事件（仅保留目标分支）
   */
  filterPush(payload: Record<string, unknown>, targetBranch: string): boolean {
    const ref = String(payload['ref'] ?? '');
    return ref.includes(targetBranch);
  }

  /**
   * health —— 连接器健康检查
   */
  async health(): Promise<ConnectorHealth> {
    return {
      type: 'github',
      ok: true,
      latencyMs: 3,
      lastSyncAt: new Date().toISOString(),
    };
  }

  getEvents(): DomainEvent[] {
    return this.events;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// H2 Jira 连接器
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class JiraConnector {
  private readonly logger = new Logger(JiraConnector.name);
  private readonly config: ConnectorConfig;
  private readonly issueStore = new Map<string, Record<string, unknown>>();
  private retryCount = 0;

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  /**
   * queryIssue —— 查询 Jira 工单
   * stub: 根据 issueKey 从内存 store 查找
   */
  async queryIssue(issueKey: string): Promise<Record<string, unknown> | null> {
    return this.issueStore.get(issueKey) ?? null;
  }

  /**
   * syncStatus —— 同步工单状态到 AegisCI 门禁
   * 返回 true 表示工单已关闭（允许门禁通过）
   */
  async syncStatus(issueKey: string): Promise<{ ok: boolean; status: string }> {
    const issue = this.issueStore.get(issueKey);
    if (!issue) return { ok: false, status: 'unknown' };
    const resolved = issue['status'] === 'Done' || issue['status'] === 'Closed';
    return { ok: resolved, status: String(issue['status'] ?? 'Open') };
  }

  /**
   * createComment —— 在工单上创建评论（门禁通知）
   */
  async createComment(issueKey: string, comment: string): Promise<ConnectorResult> {
    const existing = this.issueStore.get(issueKey) ?? {};
    this.issueStore.set(issueKey, { ...existing, comment, lastNotifiedAt: new Date().toISOString() });
    this.logger.debug(`[Jira] createComment issueKey=${issueKey}`);
    return { ok: true, code: 201, message: 'comment created' };
  }

  /**
   * simulateFailure —— 模拟 Jira API 失败，用于重试测试
   */
  async simulateFailure(): Promise<ConnectorResult> {
    this.retryCount++;
    if (this.retryCount < 3) {
      return { ok: false, code: 503, message: 'Jira API temporarily unavailable' };
    }
    return { ok: true, code: 200, message: 'recovered after retry' };
  }

  getRetryCount(): number {
    return this.retryCount;
  }

  /**
   * health —— 连接器健康检查
   */
  async health(): Promise<ConnectorHealth> {
    return {
      type: 'jira',
      ok: true,
      latencyMs: 15,
      lastSyncAt: new Date().toISOString(),
    };
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// H2 Harbor 连接器
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

@Injectable()
export class HarborConnector {
  private readonly logger = new Logger(HarborConnector.name);
  private readonly config: ConnectorConfig;
  private readonly images = new Map<string, { digest: string; signed: boolean; project: string }>();

  constructor(config: ConnectorConfig) {
    this.config = config;
  }

  /**
   * pushImage —— 推送镜像到 Harbor
   * stub: 记录镜像元数据（digest、签名状态）
   */
  async pushImage(repo: string, tag: string, digest: string, signed: boolean): Promise<ConnectorResult> {
    const key = `${repo}:${tag}`;
    this.images.set(key, { digest, signed, project: this.config.tenantId });
    this.logger.debug(`[Harbor] pushImage repo=${key} signed=${signed} digest=${digest.slice(0, 16)}...`);
    return { ok: true, code: 201, message: `image ${key} pushed` };
  }

  /**
   * verifySignature —— 验证镜像 cosign 签名链
   * stub: 检查 images map 中该镜像是否标记为 signed
   */
  async verifySignature(repo: string, tag: string): Promise<{ ok: boolean; signed: boolean }> {
    const key = `${repo}:${tag}`;
    const entry = this.images.get(key);
    if (!entry) return { ok: false, signed: false };
    return { ok: true, signed: entry.signed };
  }

  /**
   * listImages —— 列出仓库中的镜像
   */
  async listImages(repo: string): Promise<string[]> {
    const result: string[] = [];
    for (const key of this.images.keys()) {
      if (key.startsWith(`${repo}:`)) result.push(key);
    }
    return result;
  }

  /**
   * health —— 连接器健康检查
   */
  async health(): Promise<ConnectorHealth> {
    return {
      type: 'harbor',
      ok: true,
      latencyMs: 8,
      lastSyncAt: new Date().toISOString(),
    };
  }

  getImages(): Map<string, { digest: string; signed: boolean; project: string }> {
    return this.images;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// H2 连接器工厂
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class ConnectorFactory {
  static create(config: ConnectorConfig, emitter: EventEmitter2): GitLabConnector | GitHubConnector | JiraConnector | HarborConnector {
    switch (config.type) {
      case 'gitlab':  return new GitLabConnector(config, emitter);
      case 'github':  return new GitHubConnector(config, emitter);
      case 'jira':    return new JiraConnector(config);
      case 'harbor':  return new HarborConnector(config);
      default:
        throw new Error(`Unknown connector type: ${config.type}`);
    }
  }
}
