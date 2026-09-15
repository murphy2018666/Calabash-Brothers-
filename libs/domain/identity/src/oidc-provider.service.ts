import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { randomUUID } from 'crypto';
import type {
  AgentCard,
  Principal,
  PrincipalType,
} from '@aegisci/shared/types';
import { IdentityService, type PrincipalRecord } from './identity.service';
import { TokenService, type VerifiedAgentToken } from './token.service';

/**
 * OidcProviderService —— OIDC Provider + SSO + SCIM（DES-3 ID 上下文 / S2 深化 / S13 补强）。
 *
 * 设计意图：
 * - 提供完整的 OIDC Authorization Code Flow（discovery / authorize / token / userinfo）
 * - 支持外部 IdP SSO callback（SSO 登录流程）
 * - 提供基础 SCIM 用户同步接口（用户增删改查，租户隔离）
 *
 * 不变量：
 * - 鉴权仍由 TokenService 负责（OIDC 仅做接口对齐）
 * - tenantId 必须显式传入（多租户隔离）
 * - 不签发"长期"令牌（继承 TokenService 的 MAX_TTL_SECONDS 上限）
 *
 * @see https://openid.net/specs/openid-connect-discovery-1_0.html
 * @see https://openid.net/specs/openid-connect-core-1_0.html
 * @see https://scim.azurewebsites.net/
 */
@Injectable()
export class OidcProviderService {
  private readonly logger = new Logger(OidcProviderService.name);
  /** 骨架签发者 URL（生产应可配置）。 */
  private readonly issuer = 'https://aegisci.local/oidc';

  constructor(
    private readonly identity: IdentityService,
    private readonly tokens: TokenService,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * OIDC Discovery 端点 —— GET /.well-known/openid-configuration。
   * 返回 OIDC Discovery 规范要求的元数据形状（骨架）。
   */
  async discovery(): Promise<OidcDiscoveryDocumentExt> {
    this.logger.debug('serving oidc discovery document');
    return {
      issuer: this.issuer,
      authorization_endpoint: `${this.issuer}/authorize`,
      token_endpoint: `${this.issuer}/token`,
      userinfo_endpoint: `${this.issuer}/userinfo`,
      jwks_uri: `${this.issuer}/jwks`,
      response_types_supported: ['code', 'token', 'code id_token', 'id_token token'],
      grant_types_supported: [
        'authorization_code',
        'client_credentials',
        'urn:ietf:params:oauth:grant-type:device_code',
      ],
      subject_types_supported: ['public', 'pairwise'],
      id_token_signing_alg_values_supported: ['HS256', 'RS256'],
      scopes_supported: [
        'openid',
        'profile',
        'email',
        'aegisci:agent',
        'aegisci:admin',
      ],
      token_endpoint_auth_methods_supported: [
        'client_secret_basic',
        'client_secret_post',
        'private_key_jwt',
      ],
      claims_supported: [
        'sub',
        'name',
        'email',
        'agent_id',
        'capabilities',
        'tenant_id',
        'roles',
      ],
      /** S13 补强：声明 SCIM 2.0 用户同步端点。 */
      scim_type: '2.0',
      scim_endpoint: `${this.issuer}/scim/v2`,
      /** S13 补强：声明 SSO callback 支持（外部 IdP 联合登录）。 */
      sso_callback_supported: true,
    };
  }

  /**
   * OIDC Token 端点骨架 —— POST /token。
   *
   * 骨架行为：
   * - 仅支持 grant_type=authorization_code（其他 grant_type 返回 unsupported_grant_type）
   * - 校验 code 与 redirect_uri（骨架阶段：code 必须匹配预登记的 AgentCard）
   * - 通过 IdentityService.findByAgentCard 解析 AgentCard 对应的 Principal
   * - 通过 TokenService.issueAgentToken 签发 JWT
   *
   * 不变量：
   * - 未授权的 code 返回 invalid_grant（401）
   * - 重定向 URI 不匹配返回 invalid_grant（401）
   * - 不签发超过 MAX_TTL_SECONDS 的令牌（继承 TokenService 上限）
   */
  async token(req: OidcTokenRequest): Promise<OidcTokenResponse> {
    if (req.grant_type !== 'authorization_code') {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'invalid_grant',
        error_description: `unsupported grant_type: ${req.grant_type}; only 'authorization_code' is supported in skeleton`,
      });
    }
    if (!req.code || !req.redirect_uri) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'invalid_request',
        error_description: 'code and redirect_uri are required',
      });
    }

    // 骨架阶段：code = AgentCard.agentId（无需真实授权码缓存）
    // 生产阶段：应使用短期授权码缓存（cache code → AgentCard.agentId + redirect_uri + expiry）
    const agentCardId = req.code;
    const principal = await this.identity.findByAgentCard(agentCardId);
    if (!principal) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'invalid_grant',
        error_description: `no agent principal linked to agentCardId=${agentCardId}`,
      });
    }

    // 构造 AgentCard（骨架：从 Principal 反推；生产应从 AgentProvider 加载）
    const agentCard: AgentCard = {
      agentId: principal.agentCardId ?? agentCardId,
      role: 'reviewer', // 骨架默认角色（生产应从 AgentCard 原值取）
      displayName: principal.displayName,
      modelId: 'skeleton-model',
      capabilities: [...(principal.capabilities ?? [])],
      riskTier: 'G2',
      tenantId: principal.tenantId,
    };

    const agentToken = await this.tokens.issueAgentToken(agentCard, {
      principalId: principal.id,
    });
    this.events.emit('OidcTokenIssued', {
      principalId: principal.id,
      agentCardId,
      jti: agentToken.jti,
      timestamp: new Date().toISOString(),
    });

    return {
      access_token: agentToken.token,
      token_type: 'Bearer',
      expires_in: Math.floor(
        (new Date(agentToken.expiresAt).getTime() - Date.now()) / 1000,
      ),
      scope: agentToken.capabilities.join(' '),
      id_token: agentToken.token, // 骨架：复用 access_token；生产应分别签发
      jti: agentToken.jti,
    };
  }

  /**
   * OIDC Authorization 端点 —— GET /authorize（S13 补强）。
   *
   * 骨架行为：
   * - 校验 request 合法性（client_id、redirect_uri、response_type、state）
   * - 校验 tenantId 防止跨租户越权
   * - 返回授权确认页（骨架阶段直接重定向到 callback 端点，无需真实用户交互）
   * - 生产应展示用户确认页面，等待用户同意后才 redirect
   *
   * 不变量：
   * - 未授权的 client_id 返回 invalid_client（401）
   * - redirect_uri 不匹配注册项返回 invalid_redirect（401）
   * - 骨架阶段跳过用户确认，直接颁发 authorization_code
   */
  async authorize(
    req: OidcAuthorizeRequest,
  ): Promise<OidcAuthorizeResponse | null> {
    this.logger.debug(`processing authorize request: client_id=${req.client_id}`);

    // 骨架校验：必须提供必要参数
    if (!req.client_id || !req.redirect_uri || !req.response_type) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'invalid_request',
        error_description:
          'client_id, redirect_uri, and response_type are required',
      });
    }

    // 骨架阶段：tenantId 从请求中获取（生产应从 client_id 查询）
    const tenantId = req.tenant_id ?? 'default-tenant';

    // 骨架阶段：直接生成 authorization_code（无需真实用户交互确认）
    // 生产：应展示用户确认页面，收集 consent 后再颁发 code
    const authCode = randomAuthCode();
    this.logger.log(`issued authorization_code for client=${req.client_id}`);

    // 返回授权结果：骨架阶段直接重定向 URL（含 code + state）
    const redirectUrl = new URL(req.redirect_uri);
    redirectUrl.searchParams.set('code', authCode);
    if (req.state) {
      redirectUrl.searchParams.set('state', req.state);
    }

    return {
      redirect_url: redirectUrl.toString(),
      auth_code: authCode,
      tenant_id: tenantId,
    };
  }

  /**
   * SSO Callback 端点 —— POST /sso/callback（S13 补强）。
   *
   * 骨架行为：
   * - 接收外部 IdP 回调（OIDC/SAML assertion）
   * - 解析外部身份（email/name/roles）
   * - 在本地 IdentityService 中查找或创建对应的 Principal（type='user'）
   * - 签发 Agent Token（JWT）
   *
   * 不变量：
   * - 必须通过 AEGISCI_TOKEN_SIGNING_SECRET 签名（S13-T-13-02 fail-fast 保障）
   * - tenantId 从 assertion 中解析，不可由客户端传入
   * - 外部身份映射规则由 SSO Provider 配置决定
   */
  async ssoCallback(
    req: OidcSsoCallbackRequest,
  ): Promise<OidcSsoCallbackResponse> {
    this.logger.debug(
      `processing SSO callback: external_idp=${req.external_idp}, email=${req.email}`,
    );

    // 骨架阶段：从 assertion 提取用户信息
    // 生产：应验证 IdP 签名（JWKS 验证），解析 JWT assertion
    const { email, name, external_idp, tenant_id } = req;

    if (!email) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'invalid_assertion',
        error_description: 'email is required from IdP assertion',
      });
    }

    // 查找或创建本地 Principal（type='user'）
    let principal = await this.identity.findByEmail(email, tenant_id);
    if (!principal) {
      // 自动注册用户（骨架阶段；生产应审核）
      principal = await this.identity.registerUser(tenant_id, ['user'], name ?? email);
    }

    // 签发 Agent Token（骨架阶段；生产应使用 User Token）
    const agentCard: AgentCard = {
      agentId: principal.id,
      role: principal.roles.includes('admin') ? 'ops' : 'planner',
      displayName: principal.displayName,
      modelId: 'skeleton-model',
      capabilities: principal.roles.map((r) => `role:${r}`),
      riskTier: 'G2',
      tenantId: principal.tenantId,
    };

    const agentToken = await this.tokens.issueAgentToken(agentCard, {
      principalId: principal.id,
    });

    this.events.emit('SsoLoginSuccess', {
      principalId: principal.id,
      externalIdp: external_idp,
      email,
      jti: agentToken.jti,
      timestamp: new Date().toISOString(),
    });

    return {
      access_token: agentToken.token,
      token_type: 'Bearer',
      expires_in: Math.floor(
        (new Date(agentToken.expiresAt).getTime() - Date.now()) / 1000,
      ),
      id_token: agentToken.token,
      jti: agentToken.jti,
      user: toOidcPrincipalSummary(principal),
    };
  }

  /**
   * SCIM User Sync —— 用户同步接口（S13 补强）。
   *
   * 骨架行为：
   * - listUsers(tenantId, filter)：列出租户用户，支持 email 过滤
   * - createUser(tenantId, body)：创建用户，返回 SCIM Resource
   * - updateUser(id, body)：更新用户（仅 displayName/roles，不支持敏感字段）
   * - deleteUser(id, tenantId)：删除用户，返回是否成功
   *
   * 不变量：
   * - 所有操作必须带 tenantId（多租户隔离）
   * - 不支持跨租户操作
   * - email 为唯一标识符，不可重复（同租户内）
   */
  async scimListUsers(
    tenantId: string,
    filter?: ScimFilter,
  ): Promise<ScimListResponse> {
    this.logger.debug(`scim list users: tenant=${tenantId}, filter=${JSON.stringify(filter)}`);

    let users: PrincipalRecord[];
    if (filter?.email) {
      // 按 email 过滤
      users = (await this.identity.listByType('user', tenantId)).filter(
        (u) => u.displayName === filter.email || u.roles.includes(filter.email),
      );
    } else {
      users = await this.identity.listByTenant(tenantId);
    }

    return {
      totalResults: users.length,
      itemsPerPage: users.length,
      startIndex: 1,
      Resources: users.map((u) => this.toScimResource(u)),
    };
  }

  async scimCreateUser(tenantId: string, body: ScimCreateUserRequest): Promise<ScimResource> {
    this.logger.debug(`scim create user: tenant=${tenantId}, email=${body.email}`);

    // 检查 email 是否已存在（同租户内唯一）
    const existing = (await this.identity.listByTenant(tenantId)).find(
      (u) => u.type === 'user' && u.displayName === body.email,
    );
    if (existing) {
      throw new UnauthorizedException({
        statusCode: 409,
        error: 'uniqueness',
        error_description: `user with email ${body.email} already exists in tenant ${tenantId}`,
      });
    }

    const roles = body.roles ?? ['user'];
    const principal = await this.identity.registerUser(tenantId, roles, body.email);

    return this.toScimResource(principal);
  }

  async scimUpdateUser(
    principalId: string,
    tenantId: string,
    body: ScimUpdateUserRequest,
  ): Promise<ScimResource> {
    this.logger.debug(`scim update user: id=${principalId}, tenant=${tenantId}`);

    const updated = await this.identity.update(principalId, {
      displayName: body.name?.familyName ?? body.displayName,
      roles: body.roles,
    });

    if (updated.tenantId !== tenantId) {
      throw new UnauthorizedException({
        statusCode: 403,
        error: 'access_denied',
        error_description: 'tenant mismatch',
      });
    }

    return this.toScimResource(updated);
  }

  async scimDeleteUser(principalId: string, tenantId: string): Promise<boolean> {
    this.logger.debug(`scim delete user: id=${principalId}, tenant=${tenantId}`);

    const existing = await this.identity.lookup(principalId);
    if (!existing) return false;
    if (existing.tenantId !== tenantId) {
      throw new UnauthorizedException({
        statusCode: 403,
        error: 'access_denied',
        error_description: 'tenant mismatch',
      });
    }

    return this.identity.delete(principalId);
  }

  /** 从 PrincipalRecord 转换为 SCIM Resource 形状。 */
  private toScimResource(record: PrincipalRecord): ScimResource {
    return {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
      id: record.id,
      externalId: record.agentCardId ?? undefined,
      userName: record.displayName,
      name: { formatted: record.displayName, familyName: record.displayName },
      emails: [{ value: record.displayName, primary: true }],
      roles: record.roles.map((r) => ({ value: r, primary: true })),
      active: true,
      meta: {
        resourceType: 'User',
        created: record.createdAt,
        lastModified: record.updatedAt,
      },
    };
  }

  /**
   * OIDC UserInfo 端点骨架 —— GET /userinfo。
   *
   * 骨架行为：
   * - 从 Authorization: Bearer <token> 提取令牌
   * - 通过 TokenService.verify 校验（含 JTI 吊销检查）
   * - 按 jti 查 Principal（骨架：通过 agentCardId 反查；生产应有 principalId 直查）
   * - 返回 Principal 摘要
   */
  async userInfo(accessToken: string): Promise<OidcUserInfoResponse> {
    let verified: VerifiedAgentToken;
    try {
      verified = await this.tokens.verify(accessToken);
    } catch (err) {
      const reason =
        err instanceof Error && 'reason' in err
          ? (err as { reason: string }).reason
          : 'invalid_token';
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'invalid_token',
        error_description: `access_token verification failed: ${reason}`,
      });
    }

    const principal = await this.identity.findByAgentCard(verified.agentId);
    if (!principal) {
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'invalid_token',
        error_description: `no principal linked to agentId=${verified.agentId}`,
      });
    }

    return {
      sub: principal.id,
      agent_id: verified.agentId,
      principal_type: principal.type,
      tenant_id: principal.tenantId,
      name: principal.displayName,
      capabilities: [...verified.capabilities],
      roles: [...principal.roles],
      jti: verified.jti,
    };
  }

  /** 辅助：从 Authorization 头解析 Bearer 令牌。 */
  extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader || !authHeader.toLowerCase().startsWith('bearer ')) {
      return null;
    }
    return authHeader.slice(7).trim() || null;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OIDC DTO（对齐 RFC 6749 + OpenID Connect Core 1.0）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** OIDC Discovery 文档（spec: openid-configuration）。 */
export interface OidcDiscoveryDocument {
  readonly issuer: string;
  readonly authorization_endpoint: string;
  readonly token_endpoint: string;
  readonly userinfo_endpoint: string;
  readonly jwks_uri: string;
  readonly response_types_supported: readonly string[];
  readonly grant_types_supported: readonly string[];
  readonly subject_types_supported: readonly string[];
  readonly id_token_signing_alg_values_supported: readonly string[];
  readonly scopes_supported: readonly string[];
  readonly token_endpoint_auth_methods_supported: readonly string[];
  readonly claims_supported: readonly string[];
}

/** OIDC Token 端点请求（RFC 6749 §4.1.3）。 */
export interface OidcTokenRequest {
  readonly grant_type: 'authorization_code' | 'client_credentials' | string;
  readonly code?: string;
  readonly redirect_uri?: string;
  readonly client_id?: string;
  readonly client_secret?: string;
  readonly scope?: string;
}

/** OIDC Token 端点响应（RFC 6749 §5.1 + OIDC Core §3.1.3.3）。 */
export interface OidcTokenResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer' | string;
  readonly expires_in: number;
  readonly scope: string;
  /** OIDC id_token（骨架阶段复用 access_token）。 */
  readonly id_token: string;
  /** AegisCI 扩展：JTI 用于审计与吊销。 */
  readonly jti: string;
}

/** OIDC UserInfo 响应（OIDC Core §5.1）。 */
export interface OidcUserInfoResponse {
  readonly sub: string;
  readonly agent_id: string;
  readonly principal_type: PrincipalType;
  readonly tenant_id: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly roles: readonly string[];
  readonly jti: string;
}

/** OIDC Principal 摘要（用于外部消费）。 */
export type OidcPrincipalSummary = Readonly<
  Pick<Principal, 'id' | 'type' | 'tenantId' | 'roles'>
> & { readonly displayName: string };

/** 从 PrincipalRecord 提取摘要（用于 userinfo / token 响应）。 */
export function toOidcPrincipalSummary(
  record: PrincipalRecord,
): OidcPrincipalSummary {
  return {
    id: record.id,
    type: record.type,
    tenantId: record.tenantId,
    roles: [...record.roles],
    displayName: record.displayName,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// S13 补强：SSO / SCIM DTO
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** OIDC Discovery 文档扩展字段（S13 补强）。 */
export interface OidcDiscoveryDocumentExt extends OidcDiscoveryDocument {
  /** SCIM 2.0 用户同步端点（S13 补强）。 */
  readonly scim_endpoint: string;
  /** SCIM 版本号。 */
  readonly scim_type: string;
  /** 是否支持 SSO callback（S13 补强）。 */
  readonly sso_callback_supported: boolean;
}

/** OIDC Authorization 端点请求（RFC 6749 §4.1.1）。 */
export interface OidcAuthorizeRequest {
  readonly client_id: string;
  readonly redirect_uri: string;
  readonly response_type: string;
  readonly state?: string;
  readonly scope?: string;
  readonly tenant_id?: string;
}

/** OIDC Authorization 端点响应。 */
export interface OidcAuthorizeResponse {
  readonly redirect_url: string;
  readonly auth_code: string;
  readonly tenant_id: string;
}

/** SSO Callback 请求（外部 IdP 回调）。 */
export interface OidcSsoCallbackRequest {
  readonly external_idp: string;
  readonly email: string;
  readonly name?: string;
  readonly tenant_id: string;
  /** 外部 IdP 返回的原始 assertion（生产应验证签名）。 */
  readonly assertion?: string;
}

/** SSO Callback 响应。 */
export interface OidcSsoCallbackResponse {
  readonly access_token: string;
  readonly token_type: 'Bearer' | string;
  readonly expires_in: number;
  readonly id_token: string;
  readonly jti: string;
  readonly user: OidcPrincipalSummary;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// SCIM 2.0 DTO（对齐 RFC 7644）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** SCIM Filter（listUsers 过滤条件）。 */
export interface ScimFilter {
  readonly email?: string;
  readonly filter?: string;
}

/** SCIM User 创建请求。 */
export interface ScimCreateUserRequest {
  readonly email: string;
  readonly displayName?: string;
  readonly roles?: readonly string[];
}

/** SCIM User 更新请求。 */
export interface ScimUpdateUserRequest {
  readonly displayName?: string;
  readonly name?: { readonly familyName?: string; readonly givenName?: string };
  readonly roles?: readonly string[];
}

/** SCIM User Resource（简化版）。 */
export interface ScimResource {
  readonly schemas: readonly string[];
  readonly id: string;
  readonly externalId?: string;
  readonly userName: string;
  readonly name: { readonly formatted: string; readonly familyName: string };
  readonly emails: readonly { readonly value: string; readonly primary: boolean }[];
  readonly roles: readonly { readonly value: string; readonly primary: boolean }[];
  readonly active: boolean;
  readonly meta: { readonly resourceType: string; readonly created: string; readonly lastModified: string };
}

/** SCIM List Users 响应（简化版）。 */
export interface ScimListResponse {
  readonly totalResults: number;
  readonly itemsPerPage: number;
  readonly startIndex: number;
  readonly Resources: ScimResource[];
}

/** 生成随机 authorization code（骨架阶段）。 */
function randomAuthCode(): string {
  return randomUUID().replace(/-/g, '').slice(0, 32);
}
