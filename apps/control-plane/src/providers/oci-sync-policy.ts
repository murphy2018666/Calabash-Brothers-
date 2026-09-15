/**
 * K8b-1: 同步策略 — OCI Registry 定向同步配置
 *
 * 对应 WBS: K8b (1.10.8b 完整私有 Registry:部署+同步)
 *
 * 功能：
 *  - 同步策略数据结构定义
 *  - 从 YAML 文件加载
 *  - 策略校验（必填字段/格式）
 */

import * as fs from 'fs';
import * as path from 'path';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * SyncPolicy —— 同步策略配置
 *
 * 字段说明：
 *  - allowedTags: 允许同步的标签过滤器（支持 glob）
 *  - excludedTenants: 排除的租户 ID（白名单模式）
 *  - scheduledSync: 是否启用定时同步
 *  - syncIntervalHours: 同步间隔（小时）
 *  - publicMarketUrl: 公共市场 Registry 地址
 *  - enabled: 策略是否启用
 */
export interface SyncPolicy {
  /** 允许同步的标签模式 */
  allowedTags: string[];
  /** 排除的租户 ID 列表 */
  excludedTenants: string[];
  /** 是否启用定时同步 */
  scheduledSync: boolean;
  /** 同步间隔（小时），默认 24 */
  syncIntervalHours: number;
  /** 公共市场 Registry 地址 */
  publicMarketUrl: string;
  /** 策略是否启用 */
  enabled: boolean;
}

/** 默认同步策略 */
export const DEFAULT_SYNC_POLICY: SyncPolicy = {
  allowedTags: ['*'],
  excludedTenants: [],
  scheduledSync: false,
  syncIntervalHours: 24,
  publicMarketUrl: '',
  enabled: false,
};

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 工具函数
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * loadSyncPolicy —— 从 YAML 文件加载同步策略
 *
 * 搜索路径优先级：
 * 1. 环境变量 AEGISCI_SYNC_POLICY
 * 2. ~/.aegisci/sync-policy.yaml
 * 3. ./sync-policy.yaml（当前目录）
 * 4. 返回默认策略
 */
export function loadSyncPolicy(envOverrides?: Partial<SyncPolicy>): SyncPolicy {
  // 1. 环境变量覆盖
  const policyPath =
    process.env.AEGISCI_SYNC_POLICY ||
    path.join(process.env.HOME || '.', '.aegisci', 'sync-policy.yaml') ||
    path.join(process.cwd(), 'sync-policy.yaml');

  // 2. 尝试读取文件
  try {
    if (fs.existsSync(policyPath)) {
      const raw = fs.readFileSync(policyPath, 'utf-8');
      const parsed = parseYaml(raw);
      const merged = mergePolicy(DEFAULT_SYNC_POLICY, parsed as Partial<SyncPolicy>);
      return validatePolicy(merged, envOverrides);
    }
  } catch (e) {
    console.warn(`[SyncPolicy] 加载策略文件失败 ${policyPath}: ${e}`);
  }

  // 3. 返回默认策略 + 环境变量覆盖
  return validatePolicy({ ...DEFAULT_SYNC_POLICY, ...envOverrides }, envOverrides);
}

/**
 * parseYaml —— 简易 YAML 解析（不依赖 js-yaml，使用 JSON 兜底）
 */
function parseYaml(text: string): Record<string, unknown> {
  // 尝试 JSON 解析
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    // 简易 YAML → JSON 转换（仅支持扁平结构）
    const result: Record<string, unknown> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const match = trimmed.match(/^(\w+):\s*(.+)$/);
      if (match) {
        const [, key, value] = match;
        // 处理数组
        if (value.startsWith('[') && value.endsWith(']')) {
          result[key] = value
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim().replace(/^["']|["']$/g, ''));
        } else {
          result[key] = parseYamlValue(value);
        }
      }
    }
    return result;
  }
}

function parseYamlValue(value: string): unknown {
  const trimmed = value.trim().replace(/^["']|["']$/g, '');
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);
  return trimmed;
}

/**
 * mergePolicy —— 合并策略（source 覆盖 base）
 */
function mergePolicy(base: SyncPolicy, source: Partial<SyncPolicy>): SyncPolicy {
  return {
    allowedTags: source.allowedTags ?? base.allowedTags,
    excludedTenants: source.excludedTenants ?? base.excludedTenants,
    scheduledSync: source.scheduledSync ?? base.scheduledSync,
    syncIntervalHours: source.syncIntervalHours ?? base.syncIntervalHours,
    publicMarketUrl: source.publicMarketUrl ?? base.publicMarketUrl,
    enabled: source.enabled ?? base.enabled,
  };
}

/**
 * validatePolicy —— 校验策略合法性
 */
export function validatePolicy(policy: SyncPolicy, envOverrides?: Partial<SyncPolicy>): SyncPolicy {
  const merged = envOverrides ? mergePolicy(policy, envOverrides) : policy;

  // 必填字段校验
  if (!Array.isArray(merged.allowedTags) || merged.allowedTags.length === 0) {
    throw new Error('SyncPolicy.allowedTags 必须是非空数组');
  }
  if (!Array.isArray(merged.excludedTenants)) {
    throw new Error('SyncPolicy.excludedTenants 必须是数组');
  }
  if (merged.syncIntervalHours < 1 || merged.syncIntervalHours > 168) {
    throw new Error('SyncPolicy.syncIntervalHours 必须在 1~168 之间');
  }
  if (merged.enabled && !merged.publicMarketUrl) {
    throw new Error('SyncPolicy.enabled=true 时必须配置 publicMarketUrl');
  }

  return merged;
}
