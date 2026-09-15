/**
 * SecretProvider SPI —— 密钥与凭证管理
 *
 * 不变量（DES-13.9 安全交叉保证）：
 * - scope 最小化、TTL ≤ 30min、熔断
 * - scope 由 Policy 注入，Provider 无权扩大
 * - 切换 Provider 不修改内核代码；凭证 scope 与 TTL 语义不变（FR-M7-05）
 *
 * 安全存储要求（等保三级 8.3.2 / S3 代码走查结论）：
 * - 生产实现必须采用信封加密（Envelope Encryption）：使用 KMS 主密钥加密凭证数据，
 *   不以任何明文形式存储或传输密钥。V1.0 EnvFileSecretProvider 仅用于测试/本地开发，
 *   其 base64url 编码的 token 无签名保护，不得用于生产。
 * - revoke/revokeAll 必须在 ≤10s 内全节点生效（FR-M3-07），实现须支持事件广播。
 *
 * 实现档位：
 * - EnvFileProvider —— 环境变量文件（V1.0 默认，零配置，非生产）
 * - VaultProvider —— HashiCorp Vault（P1，信封加密）
 * - CloudKmsProvider —— 云 KMS（P2，信封加密 + 密钥轮换）
 */

export interface CredentialScope {
  actions: string[];
  resources: string[];
  environment: string;
  ttl: number; // 秒
}

export interface IssuedCredential {
  credentialId: string;
  token: string;
  scope: CredentialScope;
  expiresAt: string;
  jti: string; // JWT ID，用于熔断追溯
}

export interface SecretProvider {
  /** 签发短时凭证 —— scope 由 Policy 注入 */
  issue(principal: string, scope: CredentialScope): Promise<IssuedCredential>;

  /** 吊销凭证 */
  revoke(jti: string): Promise<void>;

  /** 批量吊销（熔断用，≤10s 全量同步） */
  revokeAll(principal: string): Promise<string[]>;

  /** 健康检查 */
  healthy(): Promise<boolean>;
}
