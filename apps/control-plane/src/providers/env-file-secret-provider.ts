import { randomUUID } from 'crypto';
import { Injectable } from '@nestjs/common';
import type {
  CredentialScope,
  IssuedCredential,
  SecretProvider,
} from '@aegisci/core/spi/secrets';

/**
 * EnvFileSecretProvider —— 环境变量凭证提供者（V1.0 默认，SPI 实现）。
 *
 * 对应设计：DES-13 实现档位 EnvFileProvider / DES-5.3 Token 生命周期。
 * 不变量（DES-13.9 安全交叉保证）：
 * - scope 最小化、TTL ≤ 30min；scope 由 Policy 注入，Provider 无权扩大。
 * - 切换 Provider 不改内核代码（FR-M7-05）。
 *
 * L2-3 深化：
 * - TTL > 30min 直接拒绝（不再静默 clamp）
 * - 维护 JTI → principal 全量索引，revokeAll 按 principal 反查
 * - verify(token) 公共方法：base64url 解码 + 过期 + 吊销校验
 *
 * 实现说明：从 process.env 读取运行时配置（环境/默认模型），
 * 签发 base64url 编码的短时凭证（占位签名，真实实现为 ed25519 JWT）。
 */
const MAX_TTL_SECONDS = 30 * 60;

/** Token 内部声明结构（与 encode/decode 对齐）。 */
interface TokenClaims {
  jti: string;
  principal: string;
  env: string;
  scope: CredentialScope;
  expiresAt: string;
}

/** verify() 返回结构（ Impl-level API，非 SPI 契约）。 */
export interface VerifiedToken {
  valid: boolean;
  jti?: string;
  principal?: string;
  expired: boolean;
  revoked: boolean;
  expiresAt?: string;
}

/**
 * TTL 越界错误：scope.ttl > 30min 时 issue() 抛出。
 * fail-closed：拒绝签发而非静默截断，避免上层误判凭证有效期。
 */
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

@Injectable()
export class EnvFileSecretProvider implements SecretProvider {
  /** 已吊销 JTI 集合（revoke/revokeAll 写入，verify 读取）。 */
  private readonly revoked = new Set<string>();
  /** JTI → principal 全量索引（revokeAll 反查用，issue 写入）。 */
  private readonly jtiToPrincipal = new Map<string, string>();

  async issue(principal: string, scope: CredentialScope): Promise<IssuedCredential> {
    if (scope.ttl > MAX_TTL_SECONDS) {
      // L2-3：fail-closed，拒绝越界 TTL 而非 clamp。
      throw new TtlOverflowError(scope.ttl, MAX_TTL_SECONDS);
    }
    const ttl = scope.ttl;
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const env = process.env.AEGISCI_ENV ?? scope.environment ?? 'development';
    const token = this.encode({ jti, principal, env, scope, expiresAt });
    // 维护 principal 反查索引（revokeAll 用）。
    this.jtiToPrincipal.set(jti, principal);
    return {
      credentialId: randomUUID(),
      token,
      scope: { ...scope, ttl },
      expiresAt,
      jti,
    };
  }

  async revoke(jti: string): Promise<void> {
    this.revoked.add(jti);
  }

  async revokeAll(principal: string): Promise<string[]> {
    // L2-3：按 principal 反查所有 JTI，加入吊销集合并返回受影响 JTI 列表。
    const revoked: string[] = [];
    for (const [jti, p] of this.jtiToPrincipal.entries()) {
      if (p === principal) {
        this.revoked.add(jti);
        revoked.push(jti);
      }
    }
    return revoked;
  }

  async healthy(): Promise<boolean> {
    return true;
  }

  /**
   * 解码并校验 Token：base64url 解码 + 过期 + 吊销检查（Impl-level API）。
   *
   * 返回结构包含 valid/expired/revoked/jti/principal 字段，便于上层显式区分
   * 失败原因（过期 vs 吊销 vs 篡改），而非仅返回 boolean。
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

  private encode(claims: TokenClaims): string {
    // 骨架：base64url 编码声明；真实实现为 ed25519 签名 JWT。
    return `env.${Buffer.from(JSON.stringify(claims)).toString('base64url')}`;
  }

  private decode(token: string): TokenClaims | null {
    if (!token.startsWith('env.')) {
      return null;
    }
    const payload = token.slice(4);
    try {
      const json = Buffer.from(payload, 'base64url').toString('utf8');
      return JSON.parse(json) as TokenClaims;
    } catch {
      return null;
    }
  }
}
