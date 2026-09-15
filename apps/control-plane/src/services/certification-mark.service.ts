import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';

/**
 * 认证标识防伪 Service（K12-2）。
 *
 * 标识格式：AEGISCIA-CERT-{skillId}-{certifiedAtHash}-{signature}
 * 签名算法：HMAC-SHA256（MVP 阶段固定密钥）
 *
 * 解析策略：signature 是固定 64 字符 hex，certifiedAtHash 是固定 12 字符 hex，
 * 两者之间有 '-' 分隔。从后缀末尾反向提取，再向前定位 hash，中间部分即为 skillId。
 */
@Injectable()
export class CertificationMarkService {
  private readonly logger = new Logger(CertificationMarkService.name);

  /** MVP 阶段固定密钥；production 应对接 Vault */
  private readonly signingKey = 'aegisci-cert-mvp-key-2024';

  private static readonly PREFIX = 'AEGISCIA-CERT-';
  private static readonly HASH_LEN = 12;
  private static readonly SIG_LEN = 64; // HMAC-SHA256 hex digest length

  /** 生成认证标识 */
  generateCertifiedMark(skillId: string, certifiedAt: string): string {
    const certifiedAtHash = crypto
      .createHash('sha256')
      .update(certifiedAt)
      .digest('hex')
      .slice(0, CertificationMarkService.HASH_LEN);
    const payload = `${CertificationMarkService.PREFIX}${skillId}-${certifiedAtHash}`;
    const signature = this.sign(payload);
    return `${payload}-${signature}`;
  }

  /** 验证认证标识 */
  verifyCertifiedMark(mark: string): { valid: boolean; skillId: string; certifiedAtHash: string } {
    try {
      if (!mark.startsWith(CertificationMarkService.PREFIX)) {
        return { valid: false, skillId: '', certifiedAtHash: '' };
      }
      const suffix = mark.slice(CertificationMarkService.PREFIX.length);
      // 后缀格式：{skillId}-{certifiedAtHash(12)}-{signature(64)}
      // 总长度 = skillId长度 + 1(dash) + 12(hash) + 1(dash) + 64(sig)
      // signature 在最后 64 个字符，之前有一个 '-' 分隔符
      if (suffix.length < CertificationMarkService.SIG_LEN + CertificationMarkService.HASH_LEN + 2) {
        return { valid: false, skillId: '', certifiedAtHash: '' };
      }
      // signature 从 suffix.length - SIG_LEN 开始
      const sigStart = suffix.length - CertificationMarkService.SIG_LEN;
      const sig = suffix.slice(sigStart);
      if (sig.length !== CertificationMarkService.SIG_LEN || !/^[a-f0-9]{64}$/.test(sig)) {
        return { valid: false, skillId: '', certifiedAtHash: '' };
      }
      // signature 前必须有一个 '-' 分隔符
      if (suffix[sigStart - 1] !== '-') {
        return { valid: false, skillId: '', certifiedAtHash: '' };
      }
      // certifiedAtHash 在 sigStart - 1 - HASH_LEN 到 sigStart - 1 之间
      const hashEnd = sigStart - 1;
      const hashStart = hashEnd - CertificationMarkService.HASH_LEN;
      if (hashStart < 0) {
        return { valid: false, skillId: '', certifiedAtHash: '' };
      }
      const certifiedAtHash = suffix.slice(hashStart, hashEnd);
      if (!/^[a-f0-9]{12}$/.test(certifiedAtHash)) {
        return { valid: false, skillId: '', certifiedAtHash: '' };
      }
      // hash 前必须有一个 '-' 分隔符
      if (suffix[hashStart - 1] !== '-') {
        return { valid: false, skillId: '', certifiedAtHash: '' };
      }
      const skillId = suffix.slice(0, hashStart - 1);
      if (!skillId) {
        return { valid: false, skillId: '', certifiedAtHash: '' };
      }

      const payload = `${CertificationMarkService.PREFIX}${skillId}-${certifiedAtHash}`;
      const expectedSignature = this.sign(payload);
      const valid = crypto.timingSafeEqual(
        Buffer.from(expectedSignature),
        Buffer.from(sig),
      );
      this.logger.log(`Certification mark verification: skillId=${skillId}, valid=${valid}`);
      return { valid, skillId, certifiedAtHash };
    } catch {
      return { valid: false, skillId: '', certifiedAtHash: '' };
    }
  }

  /** HMAC-SHA256 签名 */
  private sign(payload: string): string {
    return crypto
      .createHmac('sha256', this.signingKey)
      .update(payload)
      .digest('hex');
  }
}
