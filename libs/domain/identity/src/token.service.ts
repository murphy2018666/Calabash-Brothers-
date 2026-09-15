import { createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { AgentCard } from '@aegisci/shared/types';

/** Agent Token 登记册抽象（JTI 追踪 + 熔断清单）。 */
export const AGENT_TOKEN_REGISTRY = Symbol('AGENT_TOKEN_REGISTRY');

export interface AgentTokenRegistryEntry {
  readonly agentId: string;
  readonly capabilities: readonly string[];
  readonly expiresAt: string;
  /** 签发时间戳（ISO 字符串），用于审计追溯。 */
  readonly issuedAt: string;
}

export interface AgentTokenRegistry {
  register(jti: string, entry: AgentTokenRegistryEntry, ttlSeconds: number): Promise<void>;
  revoke(jti: string): Promise<void>;
  listByAgent(agentId: string): Promise<string[]>;
  /**
   * 检查 JTI 是否已吊销（用于 verify 路径）。
   * 可选实现：未提供时由 TokenService 通过 listByAgent 兜底（性能略差，等价语义）。
   */
  isRevoked?(jti: string): Promise<boolean>;
}

export interface AgentToken {
  readonly tokenId: string;
  readonly token: string;
  readonly agentId: string;
  readonly capabilities: readonly string[];
  readonly jti: string;
  readonly expiresAt: string;
  readonly issuedAt: string;
}

/** 已解码的令牌载荷（verify 返回值）。 */
export interface VerifiedAgentToken {
  readonly jti: string;
  readonly agentId: string;
  readonly capabilities: readonly string[];
  readonly issuedAt: string;
  readonly expiresAt: string;
  /** 关联的 Principal ID（如能解析；否则为 undefined）。 */
  readonly principalId?: string;
}

/** TTL 上限：≤30min（DES-5.1 Agent 主体 / 安全交叉保证）。 */
export const MAX_TTL_SECONDS = 30 * 60;

/** 令牌签发选项。 */
export interface IssueAgentTokenOptions {
  /** 自定义 TTL（秒），不得超过 MAX_TTL_SECONDS；超限自动截断。 */
  readonly ttlSeconds?: number;
  /**
   * 自定义签名密钥（临时覆盖生产密钥，仅限测试场景使用）。
   * 生产环境必须通过 AEGISCI_TOKEN_SIGNING_SECRET 环境变量注入。
   */
  readonly signingSecret?: string;
  /** 关联的 Principal ID（可选，用于审计回溯）。 */
  readonly principalId?: string;
}

/**
 * TokenVerificationError —— 令牌校验失败异常（401 Unauthorized）。
 * 失败原因：INVALID_FORMAT / INVALID_SIGNATURE / EXPIRED / REVOKED。
 */
export class TokenVerificationError extends UnauthorizedException {
  public readonly reason:
    | 'INVALID_FORMAT'
    | 'INVALID_SIGNATURE'
    | 'EXPIRED'
    | 'REVOKED';
  constructor(
    reason:
      | 'INVALID_FORMAT'
      | 'INVALID_SIGNATURE'
      | 'EXPIRED'
      | 'REVOKED',
    message: string,
  ) {
    super({ statusCode: 401, error: 'Unauthorized', reason, message });
    this.reason = reason;
    Object.setPrototypeOf(this, TokenVerificationError.prototype);
  }
}

/** JWT 头部声明（HS256）。 */
interface JwtHeader {
  readonly alg: 'HS256';
  readonly typ: 'JWT';
}

/** JWT 载荷声明。 */
interface JwtPayload {
  readonly iss: string;
  readonly sub: string; // agentId
  readonly jti: string;
  readonly capabilities: readonly string[];
  readonly iat: number; // 签发时间（Unix 秒）
  readonly exp: number; // 过期时间（Unix 秒）
  readonly principalId?: string;
}

/**
 * Identity 子域 —— Agent 身份令牌签发与校验（DES-5.1 Agent 主体 / S2 深化）。
 *
 * 令牌契约：
 * - 算法：HS256（HMAC-SHA256 + base64url）；S3+ 目标升级为 EdDSA（ed25519）
 * - TTL：≤30min（MAX_TTL_SECONDS 硬上限，超限自动截断）
 * - Scope：收窄于 AgentCard.capabilities 最小集（声明式快照）
 * - JTI：randomUUID()，签发时入 AGENT_TOKEN_REGISTRY 登记册
 * - 校验：解码 → 验签 → 验过期 → 验 JTI 是否已吊销
 * - 吊销：按 JTI 单吊 / 按 agentId 全吊（revokeAll）
 *
 * 注：本服务签发 Agent 身份令牌（who you are）；
 *     每次 Agent 工具调用的能力凭证（what you can do）由 PO/Credential 子域按裁决签发。
 */
@Injectable()
export class TokenService {
  private readonly logger = new Logger(TokenService.name);
  private readonly issuer = 'aegisci:identity';
  private readonly signingSecret: string;

  constructor(
    @Inject(AGENT_TOKEN_REGISTRY) private readonly registry: AgentTokenRegistry,
    private readonly events: EventEmitter2,
  ) {
    // S13 合规补强：删除静态默认密钥，生产环境必须通过环境变量注入签名密钥
    // GB/T 22239-2019 8.3.5 数据保密性：敏感安全参数不得硬编码或泄露于代码中
    const secret = process.env.AEGISCI_TOKEN_SIGNING_SECRET;
    if (!secret) {
      throw new Error(
        'AEGISCI_TOKEN_SIGNING_SECRET environment variable is required. ' +
        'SaaS production deployments must not use the default skeleton key.',
      );
    }
    this.signingSecret = secret;
  }

  /**
   * 签发 Agent 身份令牌（JWT + JTI）。
   * 不变量：
   * - TTL ≤ MAX_TTL_SECONDS（超限截断并 log 警告）
   * - capabilities = AgentCard.capabilities 的最小快照（声明式，签发后不可变）
   * - JTI 必入登记册，确保可追溯 + 可吊销
   */
  async issueAgentToken(
    card: AgentCard,
    options: IssueAgentTokenOptions = {},
  ): Promise<AgentToken> {
    const requestedTtl = options.ttlSeconds ?? MAX_TTL_SECONDS;
    const ttl = Math.min(requestedTtl, MAX_TTL_SECONDS);
    if (requestedTtl > MAX_TTL_SECONDS) {
      this.logger.warn(
        `requested TTL ${requestedTtl}s exceeds MAX_TTL_SECONDS; truncated to ${ttl}s (agentId=${card.agentId})`,
      );
    }
    if (ttl <= 0) {
      throw new Error(`invalid TTL: ${ttl}`);
    }

    const now = new Date();
    const issuedAt = now.toISOString();
    const iat = Math.floor(now.getTime() / 1000);
    const exp = iat + ttl;
    const expiresAt = new Date(exp * 1000).toISOString();
    const jti = randomUUID();

    const payload: JwtPayload = {
      iss: this.issuer,
      sub: card.agentId,
      jti,
      capabilities: [...card.capabilities],
      iat,
      exp,
      principalId: options.principalId,
    };
    const token = this.encode(
      payload,
      options.signingSecret ?? this.signingSecret,
    );

    await this.registry.register(
      jti,
      { agentId: card.agentId, capabilities: card.capabilities, expiresAt, issuedAt },
      ttl,
    );

    this.logger.debug(
      `issued agent token for ${card.agentId} (jti=${jti}, ttl=${ttl}s, cap=${card.capabilities.length})`,
    );

    return {
      tokenId: randomUUID(),
      token,
      agentId: card.agentId,
      capabilities: [...card.capabilities],
      jti,
      expiresAt,
      issuedAt,
    };
  }

  /**
   * 校验令牌 —— 解码 + 验签 + 验过期 + 验 JTI 是否已吊销。
   * 失败抛 TokenVerificationError（401）。
   *
   * 吊销检查路径：
   * - 若 registry 实现了 isRevoked()，优先调用（O(1)）
   * - 否则回退到 listByAgent()：JTI 不在 active 列表中即视为已吊销
   */
  async verify(
    token: string,
    options: { readonly signingSecret?: string } = {},
  ): Promise<VerifiedAgentToken> {
    const secret = options.signingSecret ?? this.signingSecret;
    const payload = this.decodeAndVerifySignature(token, secret);
    const now = Math.floor(Date.now() / 1000);
    if (now >= payload.exp) {
      throw new TokenVerificationError(
        'EXPIRED',
        `token expired at ${new Date(payload.exp * 1000).toISOString()} (jti=${payload.jti})`,
      );
    }
    const revoked = await this.isJtiRevoked(payload.jti, payload.sub);
    if (revoked) {
      throw new TokenVerificationError(
        'REVOKED',
        `token revoked (jti=${payload.jti}, agentId=${payload.sub})`,
      );
    }
    return {
      jti: payload.jti,
      agentId: payload.sub,
      capabilities: payload.capabilities,
      issuedAt: new Date(payload.iat * 1000).toISOString(),
      expiresAt: new Date(payload.exp * 1000).toISOString(),
      principalId: payload.principalId,
    };
  }

  /**
   * 检查 JTI 是否已吊销 —— 优先调用 registry.isRevoked()，
   * 未实现时回退到 listByAgent() 检查 JTI 不在 active 列表中。
   */
  private async isJtiRevoked(jti: string, agentId: string): Promise<boolean> {
    if (typeof this.registry.isRevoked === 'function') {
      return this.registry.isRevoked(jti);
    }
    // 回退：listByAgent 返回 active（未吊销）JTIs；jti 不在其中即视为已吊销
    const activeJtis = await this.registry.listByAgent(agentId);
    return !activeJtis.includes(jti);
  }

  /** 按 JTI 吊销单个令牌。 */
  async revokeAgentToken(jti: string): Promise<void> {
    await this.registry.revoke(jti);
    this.events.emit('AgentTokenRevoked', { jti, timestamp: new Date().toISOString() });
    this.logger.log(`revoked agent token (jti=${jti})`);
  }

  /** 吊销某 Agent 的全部令牌（F1-2 命名约定：按 agentId 全吊）。 */
  async revokeAll(agentId: string): Promise<string[]> {
    const jtis = await this.registry.listByAgent(agentId);
    await Promise.all(jtis.map((j) => this.registry.revoke(j)));
    if (jtis.length > 0) {
      this.events.emit('AgentTokensRevoked', {
        agentId,
        jtis,
        timestamp: new Date().toISOString(),
      });
      this.logger.log(
        `revoked ${jtis.length} agent tokens for agentId=${agentId}`,
      );
    }
    return jtis;
  }

  /**
   * 兼容 S1 命名（按 agentId 吊销全部）。
   * @deprecated 改用 revokeAll()
   */
  async revokeAgent(agentId: string): Promise<string[]> {
    return this.revokeAll(agentId);
  }

  /**
   * 编码 JWT —— base64url(header).base64url(payload).base64url(signature)。
   * 签名算法：HMAC-SHA256(secret, header.payload)。
   */
  private encode(payload: JwtPayload, secret: string): string {
    const header: JwtHeader = { alg: 'HS256', typ: 'JWT' };
    const headerB64 = this.base64Url(JSON.stringify(header));
    const payloadB64 = this.base64Url(JSON.stringify(payload));
    const signingInput = `${headerB64}.${payloadB64}`;
    const signature = createHmac('sha256', secret).update(signingInput).digest('base64url');
    return `${signingInput}.${signature}`;
  }

  /** 解码并验签 —— 失败抛 TokenVerificationError。 */
  private decodeAndVerifySignature(token: string, secret: string): JwtPayload {
    const parts = token.split('.');
    if (parts.length !== 3) {
      throw new TokenVerificationError(
        'INVALID_FORMAT',
        `token must have 3 segments, got ${parts.length}`,
      );
    }
    const [headerB64, payloadB64, signatureB64] = parts as [string, string, string];
    const signingInput = `${headerB64}.${payloadB64}`;

    // 验签（时序安全的等值比较）
    const expected = createHmac('sha256', secret).update(signingInput).digest();
    const actual = Buffer.from(signatureB64, 'base64url');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new TokenVerificationError(
        'INVALID_SIGNATURE',
        `token signature verification failed`,
      );
    }

    // 解码头部（必须 alg=HS256 typ=JWT）
    let header: unknown;
    try {
      header = JSON.parse(this.base64UrlDecode(headerB64));
    } catch {
      throw new TokenVerificationError('INVALID_FORMAT', 'invalid header JSON');
    }
    const typedHeader = header as { alg?: string; typ?: string };
    if (typedHeader?.alg !== 'HS256' || typedHeader?.typ !== 'JWT') {
      throw new TokenVerificationError(
        'INVALID_FORMAT',
        `unsupported alg/typ: alg=${typedHeader?.alg} typ=${typedHeader?.typ}`,
      );
    }

    // 解码载荷
    let payload: unknown;
    try {
      payload = JSON.parse(this.base64UrlDecode(payloadB64));
    } catch {
      throw new TokenVerificationError('INVALID_FORMAT', 'invalid payload JSON');
    }
    const typedPayload = payload as Partial<JwtPayload>;
    if (
      !typedPayload ||
      !typedPayload.jti ||
      !typedPayload.sub ||
      typeof typedPayload.exp !== 'number'
    ) {
      throw new TokenVerificationError(
        'INVALID_FORMAT',
        'payload missing required claims (jti/sub/exp)',
      );
    }
    return typedPayload as JwtPayload;
  }

  private base64Url(input: string): string {
    return Buffer.from(input, 'utf8').toString('base64url');
  }

  private base64UrlDecode(input: string): string {
    return Buffer.from(input, 'base64url').toString('utf8');
  }
}
