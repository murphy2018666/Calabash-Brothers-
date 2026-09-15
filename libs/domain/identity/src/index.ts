/**
 * Identity 子域入口（DES-3 ID 上下文）。
 * 主体注册/查询 + Agent 身份令牌签发（能力清单收窄）+ OIDC Provider 骨架。
 */
export { IdentityService } from './identity.service';
export type {
  PrincipalRecord,
  PrincipalQuery,
  PrincipalUpdateInput,
} from './identity.service';
export {
  TokenService,
  AGENT_TOKEN_REGISTRY,
  MAX_TTL_SECONDS,
} from './token.service';
export type {
  AgentToken,
  AgentTokenRegistry,
  AgentTokenRegistryEntry,
  VerifiedAgentToken,
  IssueAgentTokenOptions,
} from './token.service';
export { TokenVerificationError } from './token.service';
export { OidcProviderService } from './oidc-provider.service';
export type {
  OidcDiscoveryDocument,
  OidcTokenRequest,
  OidcTokenResponse,
  OidcUserInfoResponse,
  OidcPrincipalSummary,
  OidcDiscoveryDocumentExt,
  OidcAuthorizeRequest,
  OidcAuthorizeResponse,
  OidcSsoCallbackRequest,
  OidcSsoCallbackResponse,
  ScimFilter,
  ScimCreateUserRequest,
  ScimUpdateUserRequest,
  ScimResource,
  ScimListResponse,
} from './oidc-provider.service';
export { toOidcPrincipalSummary } from './oidc-provider.service';
export {
  IdentityModule,
  PRINCIPAL_REPOSITORY,
} from './identity.module';
export type { PrincipalRepository } from './identity.module';
