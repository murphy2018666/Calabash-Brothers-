import { randomUUID } from 'crypto';
import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DomainEvent, SkillManifest, SkillState } from '@aegisci/shared/types';
import { SkillReviewService } from './skill-review.service';

export interface SkillRecord {
  readonly skillId: string;
  readonly manifest: SkillManifest;
  state: SkillState;
  readonly signatureVerified: boolean;
  readonly installedAt: string;
  readonly tenantId: string;
}

/**
 * Skill 子域服务 —— 技能生命周期（DES-11.3）。
 * 状态机：registered → reviewing → approved → active → disabled/revoked。
 * 吊销级联：revoke 发布 SkillRevoked，Credential 子域消费后回收 Token（≤10s）。
 * 持久化目标：skill_*（骨架阶段内存暂存）。
 */
@Injectable()
export class SkillService {
  private readonly logger = new Logger(SkillService.name);
  private readonly registry = new Map<string, SkillRecord>();

  constructor(
    private readonly reviewService: SkillReviewService,
    private readonly events: EventEmitter2,
  ) {}

  /** 注册技能（含签名占位校验）—— 自动进入评审流水线。 */
  async register(manifest: SkillManifest, signature: string, tenantId: string): Promise<SkillRecord> {
    const record: SkillRecord = {
      skillId: randomUUID(),
      manifest,
      state: 'registered',
      signatureVerified: signature.length > 0,
      installedAt: new Date().toISOString(),
      tenantId,
    };
    this.registry.set(record.skillId, record);
    this.logger.debug(`registered skill ${record.skillId} (${manifest.type})`);
    record.state = 'reviewing';
    this.events.emit(
      'SkillRegistered',
      this.event('SkillRegistered', record, { skillId: record.skillId }),
    );
    return record;
  }

  /** 执行评审流水线 —— 通过则 approved，失败回退 registered。 */
  async review(skillId: string): Promise<SkillRecord> {
    const record = this.require(skillId);
    const report = await this.reviewService.runPipeline(record);
    record.state = report.passed ? 'approved' : 'registered';
    this.events.emit(
      'SkillReviewed',
      this.event('SkillReviewed', record, { passed: report.passed, report }),
    );
    return record;
  }

  /** 启用 —— 须管理员批准（DES-11.3 PendingApproval → Active）。 */
  async enable(skillId: string, approvedBy: string): Promise<void> {
    const record = this.require(skillId);
    if (record.state !== 'approved') {
      throw new Error(`skill ${skillId} not approved (state=${record.state})`);
    }
    record.state = 'active';
    this.events.emit('SkillInstalled', this.event('SkillInstalled', record, { approvedBy }));
  }

  /** 挂起 —— active → disabled。 */
  async disable(skillId: string): Promise<void> {
    const record = this.require(skillId);
    record.state = 'disabled';
    this.events.emit('SkillSuspended', this.event('SkillSuspended', record, {}));
  }

  /** 吊销 —— active/disabled → revoked；级联回收 Token（≤10s，经 SkillRevoked 事件）。 */
  async revoke(skillId: string): Promise<void> {
    const record = this.require(skillId);
    record.state = 'revoked';
    this.events.emit(
      'SkillRevoked',
      this.event('SkillRevoked', record, {
        skillId,
        principalId: this.principalFor(record),
      }),
    );
  }

  async get(skillId: string): Promise<SkillRecord | null> {
    return this.registry.get(skillId) ?? null;
  }

  async listActive(tenantId: string): Promise<SkillRecord[]> {
    return [...this.registry.values()].filter(
      (r) => r.tenantId === tenantId && r.state === 'active',
    );
  }

  private require(skillId: string): SkillRecord {
    const record = this.registry.get(skillId);
    if (!record) throw new Error(`skill not found: ${skillId}`);
    return record;
  }

  /** 技能绑定的主体（Agent skill → agentId；其余用 skill owner 占位）。 */
  private principalFor(record: SkillRecord): string {
    return record.manifest.agent?.agentId ?? `skill:${record.skillId}`;
  }

  private event<T>(eventType: string, record: SkillRecord, payload: T): DomainEvent<T> {
    return {
      eventId: randomUUID(),
      eventType,
      aggregateId: record.skillId,
      aggregateType: 'SkillManifest',
      tenantId: record.tenantId,
      payload,
      timestamp: new Date().toISOString(),
      traceId: '',
      spanId: '',
    };
  }
}
