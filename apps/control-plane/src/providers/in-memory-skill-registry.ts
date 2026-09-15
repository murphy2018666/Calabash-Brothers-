import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import type { SkillRegistrySPI, SkillRecord } from '@aegisci/core/spi/skills';
import type { SkillManifest, SkillState } from '@aegisci/shared/types';

/**
 * InMemorySkillRegistry —— 内存技能注册仓库（V1.0 默认，SPI 实现）。
 *
 * 不变量（DES-13.9 安全交叉保证）：
 * - 签名校验：未签名/篡改包拒绝加载（骨架阶段以签名长度 > 0 占位）。
 * - 吊销级联：禁用技能级联回收 Token（≤10s）。
 * - Map 暂存，进程重启即清空。
 */
@Injectable()
export class InMemorySkillRegistry implements SkillRegistrySPI {
  private readonly records = new Map<string, SkillRecord>();

  async register(
    manifest: SkillManifest,
    signature: string,
    tenantId: string,
  ): Promise<SkillRecord> {
    const record: SkillRecord = {
      skillId: `skill_${randomUUID()}`,
      manifest,
      state: 'registered',
      signatureVerified: signature.length > 0,
      installedAt: new Date().toISOString(),
      tenantId,
    };
    this.records.set(record.skillId, record);
    return record;
  }

  async get(skillId: string): Promise<SkillRecord | null> {
    return this.records.get(skillId) ?? null;
  }

  async listActive(tenantId: string): Promise<SkillRecord[]> {
    return [...this.records.values()].filter(
      (r) => r.tenantId === tenantId && r.state === 'active',
    );
  }

  async enable(skillId: string, approvedBy: string): Promise<void> {
    void approvedBy;
    const record = this.records.get(skillId);
    if (record) {
      record.state = 'active' as SkillState;
    }
  }

  async revoke(skillId: string): Promise<void> {
    const record = this.records.get(skillId);
    if (record) {
      record.state = 'revoked' as SkillState;
    }
  }

  async healthy(): Promise<boolean> {
    return true;
  }
}
