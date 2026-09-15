import type { SkillManifest, SkillState } from '@aegisci/shared/types';

/**
 * SkillRegistrySPI —— 技能注册仓库
 *
 * 不变量（DES-13.9 安全交叉保证）：
 * - 签名校验不变：未签名/篡改包拒绝加载
 * - 策略预设收窄校验：只能收窄不能放宽全局基线
 * - 吊销级联：禁用技能级联回收 Token（≤10s）
 * - 切换实现不改内核代码（FR-M7-08）
 */

export interface SkillRecord {
  skillId: string;
  manifest: SkillManifest;
  state: SkillState;
  signatureVerified: boolean;
  installedAt: string;
  tenantId: string;
}

export interface SkillRegistrySPI {
  /** 注册技能（含签名校验） */
  register(manifest: SkillManifest, signature: string, tenantId: string): Promise<SkillRecord>;

  /** 获取技能记录 */
  get(skillId: string): Promise<SkillRecord | null>;

  /** 列出租户已激活技能 */
  listActive(tenantId: string): Promise<SkillRecord[]>;

  /** 启用技能（需管理员审批，策略预设自动落位） */
  enable(skillId: string, approvedBy: string): Promise<void>;

  /** 吊销技能（级联回收 Token） */
  revoke(skillId: string): Promise<void>;

  /** 健康检查 */
  healthy(): Promise<boolean>;
}
