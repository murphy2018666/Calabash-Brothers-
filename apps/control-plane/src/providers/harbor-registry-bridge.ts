/**
 * K8b-2: Harbor Registry Bridge —— Harbor API v2 对接
 *
 * 对应 WBS: K8b (1.10.8b 完整私有 Registry:部署+同步)
 *
 * 功能：
 *  - Harbor API v2 push/pull/list/search
 *  - Bearer Token / Basic Auth 认证
 *  - 项目（Project）级别隔离（对应 tenantId）
 */

import * as crypto from 'crypto';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Harbor API 响应：项目列表 */
export interface HarborProject {
  project_id: number;
  name: string;
  creator_id: number;
  creation_time: string;
  update_time: string;
  deleted: boolean;
  public: boolean;
  registry_id: number;
}

/** Harbor API 响应：artifact 列表 */
export interface HarborArtifact {
  id: number;
  digest: string;
  size: number;
  media_type: string;
  push_time: string;
  pull_time: string;
  reference: string;
  annotations?: Record<string, string>;
}

/** Harbor API 响应：tag 列表 */
export interface HarborTag {
  id: number;
  name: string;
  push_time: string;
  pull_time: string;
  digital_signature: string[];
  annotations?: Record<string, string>;
  mutable: boolean;
}

/** Harbor Bridge 配置 */
export interface HarborBridgeConfig {
  /** Harbor 实例地址，如 https://harbor.example.com */
  url: string;
  /** Harbor 用户名 */
  username: string;
  /** Harbor 密码/token */
  password: string;
  /** Harbor 项目名称（对应 tenantId） */
  project: string;
}

/** push 结果 */
export interface HarborPushResult {
  ok: boolean;
  skillId: string;
  digest: string;
  errors: string[];
}

/** pull 结果 */
export interface HarborPullResult {
  ok: boolean;
  artifacts: HarborArtifact[];
  tags: HarborTag[];
  errors: string[];
}

/**
 * HarborRegistryBridge —— Harbor API 对接层。
 *
 * 注意：当前实现为 stub（无真实 HTTP 调用），便于单元测试。
 * 真实实现需用 axios/undici 替换 stub 方法。
 */
export class HarborRegistryBridge {
  private readonly config: HarborBridgeConfig;
  /** 本地缓存的 artifact 列表（测试用） */
  private readonly artifactsStore = new Map<
    string,
    { artifact: HarborArtifact; tag: HarborTag }[]
  >();

  constructor(config: HarborBridgeConfig) {
    this.config = config;
  }

  /**
   * push —— 推送技能包到 Harbor 项目。
   * Stub: 记录到本地缓存，真实实现需调用 Harbor API v2。
   */
  async push(skillId: string, version: string, digest: string): Promise<HarborPushResult> {
    const artifact: HarborArtifact = {
      id: Date.now(),
      digest,
      size: 0,
      media_type: 'application/vnd.oci.image.manifest.v1+json',
      push_time: new Date().toISOString(),
      pull_time: new Date().toISOString(),
      reference: `${skillId}:${version}`,
    };
    const tag: HarborTag = {
      id: Date.now(),
      name: version,
      push_time: artifact.push_time,
      pull_time: artifact.pull_time,
      digital_signature: [],
      mutable: true,
    };
    const key = `${this.config.project}/${skillId}`;
    if (!this.artifactsStore.has(key)) {
      this.artifactsStore.set(key, []);
    }
    this.artifactsStore.get(key)!.push({ artifact, tag });
    return { ok: true, skillId, digest, errors: [] };
  }

  /**
   * pull —— 从 Harbor 项目拉取技能包列表。
   */
  async pull(skillId: string): Promise<HarborPullResult> {
    const key = `${this.config.project}/${skillId}`;
    const items = this.artifactsStore.get(key) ?? [];
    return {
      ok: true,
      artifacts: items.map((i) => i.artifact),
      tags: items.map((i) => i.tag),
      errors: [],
    };
  }

  /**
   * list —— 列出项目中的所有技能。
   */
  async list(): Promise<HarborArtifact[]> {
    const all: HarborArtifact[] = [];
    for (const items of this.artifactsStore.values()) {
      all.push(...items.map((i) => i.artifact));
    }
    return all;
  }

  /**
   * search —— 搜索技能（按名称模糊匹配）。
   */
  async search(query: string): Promise<HarborArtifact[]> {
    const all = await this.list();
    const lower = query.toLowerCase();
    return all.filter((a) => a.reference.toLowerCase().includes(lower));
  }

  // ── 认证辅助 ──

  /** 生成 Bearer Token（stub：返回固定 token） */
  getAuthToken(): string {
    return `harbor_token_${crypto.randomBytes(16).toString('hex')}`;
  }

  /** 计算 Basic Auth header */
  getBasicAuthHeader(): string {
    const credentials = `${this.config.username}:${this.config.password}`;
    return `Basic ${Buffer.from(credentials).toString('base64')}`;
  }

  /** 获取配置（只读） */
  getConfig(): Readonly<HarborBridgeConfig> {
    return this.config;
  }

  /** 清空缓存（测试用） */
  clear(): void {
    this.artifactsStore.clear();
  }
}
