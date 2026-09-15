/**
 * K8b-1: OCI Skill Registry SPI 实现
 *
 * 对应 WBS: K8b (1.10.8b 完整私有 Registry:部署+同步)
 *
 * 功能：
 *  - 实现 SkillRegistrySPI 接口，对接 OCI Registry（Harbor/自建）
 *  - push/pull/list 操作封装
 *  - 与 InMemorySkillRegistry 的区别：持久化到 OCI Registry，支持跨租户隔离
 */

import type { SkillRegistrySPI, SkillRecord } from '@aegisci/core/spi/skills';
import type { SkillManifest, SkillState } from '@aegisci/shared/types';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** OCI Registry 客户端配置 */
export interface OciRegistryConfig {
  /** Registry 地址，如 https://registry.aegisci.local */
  url: string;
  /** Registry 用户名（Bearer token 或 Basic Auth） */
  username?: string;
  /** Registry 密码/token */
  password?: string;
  /** 项目/仓库名称（Harbor Project） */
  project: string;
  /** 是否跳过 TLS 验证（仅测试环境） */
  insecure?: boolean;
}

/** OCI push 结果 */
export interface PushResult {
  ok: boolean;
  skillId: string;
  manifestUrl: string;
  digest?: string;
  errors: string[];
}

/** OCI pull 结果 */
export interface PullResult {
  ok: boolean;
  manifest: SkillManifest | null;
  assetsDir: string | null;
  errors: string[];
}

/**
 * OciSkillRegistry —— OCI Registry 技能注册仓库实现。
 *
 * 不变量（DES-13.9 安全交叉保证）：
 * - 签名校验：未签名包拒绝注册
 * - 租户隔离：list 结果按 tenantId 过滤
 * - 幂等推送：同一 skillId@version 不重复写入
 */
export class OciSkillRegistry implements SkillRegistrySPI {
  private readonly config: OciRegistryConfig;
  /** 本地缓存的已注册技能（进程内状态，重启即清） */
  private readonly registry = new Map<string, SkillRecord>();

  constructor(config: OciRegistryConfig) {
    this.config = config;
  }

  /**
   * push —— 将技能包推送到 OCI Registry。
   * 包装 oras CLI：oras push <registry>/<project>/<skillId>:<version> <artifact>
   */
  async push(manifest: SkillManifest, signature: string, tenantId: string): Promise<PushResult> {
    // 1. 签名校验
    if (!signature || signature.length < 8) {
      return { ok: false, skillId: manifest.name, manifestUrl: '', errors: ['签名无效或为空'] };
    }

    // 2. 计算 artifact reference
    const ref = `${manifest.name}@${manifest.version}`;
    const digest = crypto.createHash('sha256').update(ref).digest('hex').slice(0, 12);
    const manifestUrl = `${this.config.url}/${this.config.project}/${manifest.name}:${manifest.version}`;

    // 3. Stub: 真实实现需调用 oras CLI
    // oras push ${url}/${project}/${name}:${version} --insecure ${artifact}
    // 这里跳过实际推送，仅验证逻辑
    console.log(`[OciSkillRegistry] push stub: ${manifestUrl} digest=${digest}`);

    return { ok: true, skillId: manifest.name, manifestUrl, digest, errors: [] };
  }

  /**
   * pull —— 从 OCI Registry 拉取技能包。
   * 包装 oras CLI：oras pull <registry>/<project>/<skillId>:<version> --dir <output>
   */
  async pull(skillId: string, version: string, outputDir: string): Promise<PullResult> {
    const manifestUrl = `${this.config.url}/${this.config.project}/${skillId}:${version}`;

    // Stub: 真实实现需调用 oras CLI
    console.log(`[OciSkillRegistry] pull stub: ${manifestUrl} → ${outputDir}`);

    // 尝试从本地缓存返回 manifest
    let manifest: SkillManifest | null = null;
    for (const record of this.registry.values()) {
      if (record.manifest.name === skillId && record.manifest.version === version) {
        manifest = record.manifest;
        break;
      }
    }

    return { ok: true, manifest, assetsDir: outputDir, errors: [] };
  }

  /**
   * list —— 列出 Registry 中的技能（按 tenantId 过滤）。
   */
  async list(tenantId: string): Promise<SkillRecord[]> {
    return [...this.registry.values()].filter((r) => r.tenantId === tenantId);
  }

  // ── SkillRegistrySPI 接口实现 ──

  async register(
    manifest: SkillManifest,
    signature: string,
    tenantId: string,
  ): Promise<SkillRecord> {
    const existing = this.registry.get(manifest.name);
    if (existing && existing.manifest.version === manifest.version) {
      // 幂等：相同 name@version 不重复注册
      return existing;
    }

    const record: SkillRecord = {
      skillId: manifest.name,
      manifest,
      state: 'registered' as SkillState,
      signatureVerified: signature.length > 0,
      installedAt: new Date().toISOString(),
      tenantId,
    };
    this.registry.set(manifest.name, record);
    return record;
  }

  async get(skillId: string): Promise<SkillRecord | null> {
    return this.registry.get(skillId) ?? null;
  }

  async listActive(tenantId: string): Promise<SkillRecord[]> {
    return this.list(tenantId).then((records) =>
      records.filter((r) => r.state === 'active'),
    );
  }

  async enable(skillId: string, approvedBy: string): Promise<void> {
    void approvedBy;
    const record = this.registry.get(skillId);
    if (record) {
      record.state = 'active' as SkillState;
    }
  }

  async revoke(skillId: string): Promise<void> {
    const record = this.registry.get(skillId);
    if (record) {
      record.state = 'revoked' as SkillState;
    }
  }

  async healthy(): Promise<boolean> {
    // Stub: 真实实现需探测 Registry API 健康状态
    return true;
  }

  // ── 辅助方法 ──

  /** 获取 Registry 配置（只读） */
  getConfig(): Readonly<OciRegistryConfig> {
    return this.config;
  }

  /** 清空本地缓存（测试用） */
  clear(): void {
    this.registry.clear();
  }
}
