/**
 * K8b-2: 同步调度器 —— 定时同步任务
 *
 * 对应 WBS: K8b (1.10.8b 完整私有 Registry:部署+同步)
 *
 * 功能：
 *  - 定时同步任务调度（node-cron 风格，stub 实现）
 *  - 同步策略执行（过滤标签/租户）
 *  - 同步日志记录
 */

import type { SyncPolicy } from './oci-sync-policy';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** 同步任务状态 */
export enum SyncStatus {
  IDLE = 'idle',
  RUNNING = 'running',
  COMPLETED = 'completed',
  FAILED = 'failed',
  STOPPED = 'stopped',
}

/** 同步任务结果 */
export interface SyncTaskResult {
  ok: boolean;
  skillsSynced: number;
  skillsSkipped: number;
  skillsFailed: number;
  errors: string[];
  startedAt: string;
  completedAt: string;
}

/**
 * SyncScheduler —— 同步任务调度器（stub 实现）。
 *
 * V1.5 使用内存调度器，真实实现需接入 node-cron 或 Hangfire。
 */
export class SyncScheduler {
  private status: SyncStatus = SyncStatus.IDLE;
  private policy: SyncPolicy;
  private readonly logs: string[] = [];
  private readonly publicSkills = new Map<string, { tag: string; tenant: string }[]>();

  constructor(policy: SyncPolicy) {
    this.policy = policy;
  }

  /**
   * start —— 启动同步调度（stub）。
   * 真实实现：setInterval(() => this.execute(), policy.syncIntervalHours * 3600000)
   */
  start(): void {
    if (!this.policy.enabled) {
      this.log('同步调度未启用（policy.enabled=false）');
      return;
    }
    this.status = SyncStatus.RUNNING;
    this.log(`同步调度已启动，间隔=${this.policy.syncIntervalHours}h`);
  }

  /**
   * stop —— 停止同步调度。
   */
  stop(): void {
    this.status = SyncStatus.STOPPED;
    this.log('同步调度已停止');
  }

  /**
   * execute —— 执行一次同步（stub）。
   * 根据策略过滤 publicSkills 并返回结果。
   */
  execute(): SyncTaskResult {
    if (this.status !== SyncStatus.RUNNING && this.status !== SyncStatus.IDLE) {
      return this.makeFailedResult('调度器未运行');
    }

    this.status = SyncStatus.RUNNING;
    const startedAt = new Date().toISOString();
    let synced = 0;
    let skipped = 0;
    let failed = 0;
    const errors: string[] = [];

    for (const [skillId, entries] of this.publicSkills.entries()) {
      for (const entry of entries) {
        // 1. 标签过滤
        if (!this.matchesAllowedTags(entry.tag)) {
          skipped++;
          continue;
        }
        // 2. 租户过滤
        if (this.policy.excludedTenants.includes(entry.tenant)) {
          skipped++;
          continue;
        }
        // 3. 模拟同步
        try {
          synced++;
        } catch (e: any) {
          failed++;
          errors.push(`同步 ${skillId}@${entry.tag} 失败: ${e.message}`);
        }
      }
    }

    this.status = SyncStatus.COMPLETED;
    const completedAt = new Date().toISOString();
    this.log(`同步完成: synced=${synced} skipped=${skipped} failed=${failed}`);

    return {
      ok: failed === 0,
      skillsSynced: synced,
      skillsSkipped: skipped,
      skillsFailed: failed,
      errors,
      startedAt,
      completedAt,
    };
  }

  /**
   * addPublicSkill —— 添加公共市场技能到待同步队列。
   */
  addPublicSkill(skillId: string, tag: string, tenant: string): void {
    if (!this.publicSkills.has(skillId)) {
      this.publicSkills.set(skillId, []);
    }
    this.publicSkills.get(skillId)!.push({ tag, tenant });
    this.log(`添加公共技能: ${skillId}@${tag} (tenant=${tenant})`);
  }

  /**
   * getStatus —— 获取当前调度状态。
   */
  getStatus(): SyncStatus {
    return this.status;
  }

  /**
   * getLogs —— 获取同步日志。
   */
  getLogs(): string[] {
    return [...this.logs];
  }

  // ── 私有方法 ──

  private matchesAllowedTags(tag: string): boolean {
    if (this.policy.allowedTags.length === 0 || this.policy.allowedTags.includes('*')) {
      return true;
    }
    for (const pattern of this.policy.allowedTags) {
      if (this.globMatch(tag, pattern)) return true;
    }
    return false;
  }

  /** 简易 glob 匹配（支持 * 通配符） */
  private globMatch(str: string, pattern: string): boolean {
    const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
    return regex.test(str);
  }

  private makeFailedResult(reason: string): SyncTaskResult {
    const now = new Date().toISOString();
    return {
      ok: false,
      skillsSynced: 0,
      skillsSkipped: 0,
      skillsFailed: 0,
      errors: [reason],
      startedAt: now,
      completedAt: now,
    };
  }

  private log(msg: string): void {
    this.logs.push(`[${new Date().toISOString()}] ${msg}`);
  }
}
