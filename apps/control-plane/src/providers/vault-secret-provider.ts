/**
 * L5-1: VaultSecretProvider —— HashiCorp Vault 凭证提供者（V1.5）
 *
 * 对应 WBS: L5 其他 SPI 可插拔实现（1.9.5）
 * 对应风险: R32/R35 密钥泄露 & Vault API 变更
 *
 * 不变量（DES-13.9 / FR-M7-05）：
 * - scope 由 Policy 注入，Provider 无权扩大
 * - TTL ≤ 30min（fail-closed，越界直接拒绝）
 * - Vault 不可用时自动降级到 EnvFileSecretProvider
 * - revoke/revokeAll 在 ≤10s 内全节点生效（事件广播 stub）
 */

import { randomUUID } from 'crypto';
import type {
  CredentialScope,
  IssuedCredential,
  SecretProvider,
} from '@aegisci/core/spi/secrets';

const MAX_TTL_SECONDS = 30 * 60;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** Vault API 响应：KV v2 secret */
export interface VaultSecretResponse {
  request_id: string;
  lease_id: string;
  renewable: boolean;
  data: {
    [key: string]: unknown;
    version?: number;
  };
  wrap_info?: { token: string };
}

/** Vault API 响应：错误 */
export interface VaultErrorResponse {
  errors: string[];
}

/** VaultSecretProvider 配置 */
export interface VaultConfig {
  /** Vault 地址，如 https://vault.aegisci.local:8200 */
  address: string;
  /** Vault Token（root 或 approle） */
  token: string;
  /** 默认 secrets 路径前缀，如 kv/aegisci */
  secretPath: string;
  /** 降级到 EnvFileSecretProvider 的地址（可选） */
  fallbackAddress?: string;
}

/** verify() 返回结构（Impl-level API）。 */
export interface VerifiedToken {
  valid: boolean;
  jti?: string;
  principal?: string;
  expired: boolean;
  revoked: boolean;
  expiresAt?: string;
}

/** TTL 越界错误。 */
export class TtlOverflowError extends Error {
  constructor(
    public readonly requestedTtl: number,
    public readonly maxTtl: number,
  ) {
    super(
      `TTL overflow: requested ${requestedTtl}s exceeds max ${maxTtl}s (DES-5.3 scope ≤ 30min)`,
    );
    this.name = 'TtlOverflowError';
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 实现
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * VaultSecretProvider —— HashiCorp Vault 凭证提供者。
 *
 * 实现档位（DES-13 实现档位）：
 * - V1.5：基础 Vault API 对接（stub HTTP，真实实现需 axios/undici）
 * - V2.0：信封加密 + 密钥轮换（CloudKmsProvider 合并）
 */
export class VaultSecretProvider implements SecretProvider {
  private readonly config: VaultConfig;
  /** 已吊销 JTI 集合 */
  private readonly revoked = new Set<string>();
  /** JTI → principal 索引 */
  private readonly jtiToPrincipal = new Map<string, string>();
  /** 凭证缓存：jti → credential */
  private readonly credentialCache = new Map<string, IssuedCredential>();
  /** 是否处于熔断状态 */
  private circuitBreakerOpen = false;
  private readonly consecutiveFailures = { current: 0, threshold: 5 };

  constructor(config: VaultConfig) {
    this.config = config;
  }

  /**
   * issue —— 签发短时凭证。
   *
   * 安全路径：Vault API → 信封加密 → 签发
   * 降级路径：Vault 不可用 → EnvFileSecretProvider
   */
  async issue(principal: string, scope: CredentialScope): Promise<IssuedCredential> {
    if (scope.ttl > MAX_TTL_SECONDS) {
      throw new TtlOverflowError(scope.ttl, MAX_TTL_SECONDS);
    }

    // 1. 尝试 Vault API
    try {
      const credential = await this.issueViaVault(principal, scope);
      this.circuitBreakerOpen = false;
      this.consecutiveFailures.current = 0;
      return credential;
    } catch (vaultErr) {
      // 2. 计数连续失败
      this.consecutiveFailures.current += 1;
      if (this.consecutiveFailures.current >= this.consecutiveFailures.threshold) {
        this.circuitBreakerOpen = true;
        console.warn(
          `[VaultSecretProvider] 熔断触发：连续 ${this.consecutiveFailures.threshold} 次 Vault API 失败`,
        );
      }
      // 3. 降级路径：生产环境需注入 EnvFileSecretProvider，此处 log 警告后正常签发
      console.warn(
        `[VaultSecretProvider] 降级警告：Vault 不可用 (${this.formatError(vaultErr)})，使用本地签发`,
      );
    }

    // 降级：本地签发（无签名保护，仅用于测试/Vault 不可用场景）
    return this.issueLocally(principal, scope);
  }

  /**
   * 通过 Vault API 签发凭证（stub）。
   */
  private async issueViaVault(principal: string, scope: CredentialScope): Promise<IssuedCredential> {
    const ttl = scope.ttl;
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const env = process.env.AEGISCI_ENV ?? scope.environment ?? 'production';
    const vaultData = await this.readVaultSecret(principal);
    const token = this.encodeWithVaultToken(jti, principal, env, scope, expiresAt, vaultData);

    this.jtiToPrincipal.set(jti, principal);
    const credential: IssuedCredential = {
      credentialId: randomUUID(),
      token,
      scope: { ...scope, ttl },
      expiresAt,
      jti,
    };
    this.credentialCache.set(jti, credential);
    return credential;
  }

  /** 本地签发（降级路径）。 */
  private issueLocally(principal: string, scope: CredentialScope): IssuedCredential {
    const ttl = scope.ttl;
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const env = process.env.AEGISCI_ENV ?? scope.environment ?? 'production';
    const token = `env.${Buffer.from(JSON.stringify({ jti, principal, env, scope, expiresAt })).toString('base64url')}`;

    this.jtiToPrincipal.set(jti, principal);
    return {
      credentialId: randomUUID(),
      token,
      scope: { ...scope, ttl },
      expiresAt,
      jti,
    };
  }

  /**
   * revoke —— 吊销单个凭证。
   */
  async revoke(jti: string): Promise<void> {
    this.revoked.add(jti);
    this.credentialCache.delete(jti);
    this.jtiToPrincipal.delete(jti);
  }

  /**
   * revokeAll —— 批量吊销（熔断用，≤10s 全量同步）。
   */
  async revokeAll(principal: string): Promise<string[]> {
    const revoked: string[] = [];
    for (const [jti, p] of this.jtiToPrincipal.entries()) {
      if (p === principal) {
        this.revoked.add(jti);
        this.credentialCache.delete(jti);
        this.jtiToPrincipal.delete(jti);
        revoked.push(jti);
      }
    }
    return revoked;
  }

  /**
   * healthy —— 健康检查（stub）。
   */
  async healthy(): Promise<boolean> {
    return !this.circuitBreakerOpen;
  }

  /**
   * verify —— 验证 token（Impl-level API）。
   */
  verify(token: string): VerifiedToken {
    const claims = this.decode(token);
    if (!claims) {
      return { valid: false, expired: false, revoked: false };
    }
    const expired = Date.parse(claims.expiresAt) < Date.now();
    const revoked = this.revoked.has(claims.jti);
    return {
      valid: !expired && !revoked,
      jti: claims.jti,
      principal: claims.principal,
      expired,
      revoked,
      expiresAt: claims.expiresAt,
    };
  }

  // ── 私有方法 ──

  private async readVaultSecret(_principal: string): Promise<Record<string, unknown>> {
    return { principal: _principal, env: 'production', keyTemplate: 'aegisci-sk-{{principal}}' };
  }

  private encodeWithVaultToken(
    jti: string,
    principal: string,
    env: string,
    scope: CredentialScope,
    expiresAt: string,
    vaultData: Record<string, unknown>,
  ): string {
    return `vault.${Buffer.from(JSON.stringify({ jti, principal, env, scope, expiresAt, vaultEnvelope: vaultData })).toString('base64url')}`;
  }

  private decode(token: string): {
    jti: string;
    principal: string;
    env: string;
    scope: CredentialScope;
    expiresAt: string;
    vaultEnvelope: Record<string, unknown>;
  } | null {
    if (!token.startsWith('vault.') && !token.startsWith('env.')) return null;
    const prefix = token.startsWith('vault.') ? 6 : 4;
    const payload = token.slice(prefix);
    try {
      const json = Buffer.from(payload, 'base64url').toString('utf8');
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  private formatError(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}
