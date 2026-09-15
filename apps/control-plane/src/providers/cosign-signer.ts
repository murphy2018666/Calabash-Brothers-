/**
 * K8b-2: cosign 签名/验证 —— Stub 实现（V1.5）
 *
 * 对应 WBS: K8b (1.10.8b 完整私有 Registry:部署+同步)
 *
 * 功能：
 *  - 签名生成（本地文件密钥 stub）
 *  - 签名验证
 *  - 密钥管理（未来对接 Vault）
 *
 * 注意：V1.5 使用 stub 实现，真实 cosign 操作需在 L5 SecretProvider
 * 完成后再升级。
 */

import * as crypto from 'crypto';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/** cosign 签名结果 */
export interface CosignSignature {
  ok: boolean;
  signature: string;       // base64 编码的签名
  certificate?: string;     // x509 证书（keyless 模式）
  errors: string[];
}

/** cosign 验证结果 */
export interface CosignVerifyResult {
  ok: boolean;
  certificateIdentity?: string;
  errors: string[];
}

/** cosign 配置 */
export interface CosignConfig {
  /** 密钥文件路径（本地文件模式） */
  keyPath?: string;
  /** 是否使用 keyless 模式（OIDC） */
  keyless: boolean;
  /** OIDC Issuer（keyless 模式） */
  oidcIssuer?: string;
  /** OIDC Client ID（keyless 模式） */
  oidcClientId?: string;
}

/**
 * CosignSigner —— cosign 签名/验证工具类。
 *
 * 不变量（DES-13.9 R32 安全要求）：
 * - 密钥文件权限必须为 600
 * - 签名验证必须走 WORM 审计
 */
export class CosignSigner {
  private readonly config: CosignConfig;

  constructor(config: CosignConfig) {
    this.config = config;
  }

  /**
   * sign —— 对技能包进行 cosign 签名。
   *
   * V1.5 stub: 生成固定格式签名（sig_<hex>），不实际调用 cosign CLI。
   */
  sign(imageRef: string, keyMaterial: string): CosignSignature {
    // 1. 密钥检查
    if (!keyMaterial || keyMaterial.length < 8) {
      return {
        ok: false,
        signature: '',
        errors: ['密钥材料无效或为空'],
      };
    }

    // 2. 生成签名（stub：基于 imageRef + keyMaterial 的 HMAC）
    const signature = 'sig_' + crypto
      .createHmac('sha256', keyMaterial)
      .update(imageRef)
      .digest('hex')
      .slice(0, 40);

    // 3. keyless 模式附加证书 stub
    let certificate: string | undefined;
    if (this.config.keyless) {
      certificate = `cert_${crypto.randomBytes(16).toString('hex')}`;
    }

    console.log(`[CosignSigner] signed ${imageRef} → ${signature.slice(0, 12)}...`);
    return { ok: true, signature, certificate, errors: [] };
  }

  /**
   * verify —— 验证技能包的 cosign 签名。
   *
   * V1.5 stub: 检查签名格式（以 'sig_' 开头）和证书身份。
   */
  verify(imageRef: string, signature: string): CosignVerifyResult {
    // 1. 签名格式校验
    if (!signature?.startsWith('sig_')) {
      return {
        ok: false,
        errors: [`签名格式无效: ${imageRef}`],
      };
    }

    // 2. 证书身份校验（keyless 模式）
    if (this.config.keyless && this.config.oidcIssuer) {
      // stub: 假设所有 sig_ 开头的签名都是有效的
      return {
        ok: true,
        certificateIdentity: this.config.oidcIssuer,
        errors: [],
      };
    }

    // 3. 本地密钥模式：验证 HMAC
    // stub: 不验证实际 HMAC，仅检查格式
    return {
      ok: true,
      errors: [],
    };
  }

  /**
   * verifyWithCert —— 带证书身份的签名验证。
   */
  verifyWithCert(imageRef: string, signature: string, expectedIdentity?: string): CosignVerifyResult {
    const base = this.verify(imageRef, signature);
    if (!base.ok) return base;

    if (expectedIdentity && !base.certificateIdentity) {
      return {
        ok: false,
        errors: [`签名 ${imageRef} 缺少证书身份（期望: ${expectedIdentity}）`],
      };
    }
    if (expectedIdentity && base.certificateIdentity !== expectedIdentity) {
      return {
        ok: false,
        errors: [`证书身份不匹配: 期望 ${expectedIdentity}, 实际 ${base.certificateIdentity}`],
      };
    }
    return base;
  }

  /** 获取配置（只读） */
  getConfig(): Readonly<CosignConfig> {
    return this.config;
  }
}
