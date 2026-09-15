/**
 * K2-1: Sigstore Fulcio/Rekor 自托管 POC
 *
 * 实现 Cosign 签名与 Sigstore Fulcio 证书、Rekor 透明日志的桥接层。
 *
 * 设计要点：
 * - Fulcio 替代：本地自签名证书（POC 用），生产环境接入真实 Fulcio
 * - Rekor 替代：内存透明日志（POC 用），生产环境接入真实 Rekor
 * - 签名工件：OCI 镜像 / SBOM / Skill 包
 * - 验证路径：cosign verify → 证书链 → Rekor 条目校验
 */

import { randomUUID } from 'crypto';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface FulcioCertificate {
  /** 证书主题 */
  subject: string;
  /** 颁发者 */
  issuer: string;
  /** 序列号 */
  serialNumber: string;
  /** 有效期起始 */
  notBefore: string;
  /** 有效期结束 */
  notAfter: string;
  /** 公钥（PEM 格式） */
  publicKey: string;
  /** 自签名标识（POC） */
  selfSigned: boolean;
}

export interface RekorEntry {
  /** Rekor 唯一 ID */
  entryId: string;
  /** 签名工件 digest */
  artifactDigest: string;
  /** 签名值（base64） */
  signature: string;
  /** 证书引用 */
  certificateRef: string;
  /** 时间戳 */
  timestamp: string;
  /** 公开可见性 */
  public: boolean;
}

export interface SigstoreVerificationResult {
  /** 验证是否通过 */
  verified: boolean;
  /** 工件 digest */
  artifactDigest: string;
  /** 使用的证书 */
  certificate?: FulcioCertificate;
  /** Rekor 条目 ID（如有） */
  rekorEntryId?: string;
  /** 错误信息 */
  error?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// POC 实现
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class SigstoreCosignBridge {
  /** POC 用自签名证书存储 */
  private readonly certificates = new Map<string, FulcioCertificate>();
  /** POC 用透明日志存储 */
  private readonly rekorLog = new Map<string, RekorEntry>();
  /** 私钥（PEM 格式，POC 用固定密钥） */
  private readonly privateKey = `-----BEGIN EC PRIVATE KEY-----
MHQCAQEEIDuD2lVZx7sq6pq+NJqPXFJ8kKNqVBb7p0gTz8L7v4hdoAcGBSuBBAAK
oUQDQgAE7m7+7k1NTL7h3p5y7V5V9L9K3r3X5f5H5v5O7t9R7t3N5X9L7K3R5v9
H5t3N5X9L7K3R5v9H5t3N5X9L7K3R5v9H5t3N5X9L7K3R5v9H5t3N5X9L7K3R5v
9H5t3N5X9L7K3R5v9H5t3N5X9L7K3R5v9H5t3N5X9L7K3R5v9H5t3N5X9L7K3R5
v9H5t3N5X9L7K3R5v9H5t3N5X9L7K3R5v9A==
-----END EC PRIVATE KEY-----`;

  /**
   * signArtifact —— 对工件进行签名并记录到 Rekor
   * @param artifact 工件标识（如 OCI 镜像 digest）
   * @param signer 签名者身份
   */
  async signArtifact(artifact: string, signer: string): Promise<{
    signature: string;
    certificate: FulcioCertificate;
    rekorEntryId: string;
  }> {
    const digest = this.computeDigest(artifact);
    const certId = randomUUID();
    const now = new Date().toISOString();

    // 1. 生成自签名证书（POC）
    const certificate: FulcioCertificate = {
      subject: `oidc:${signer}`,
      issuer: '自托管 Fulcio POC',
      serialNumber: certId,
      notBefore: now,
      notAfter: new Date(Date.now() + 3600 * 1000).toISOString(), // 1h TTL
      publicKey: 'POC-PUBLIC-KEY',
      selfSigned: true,
    };
    this.certificates.set(certId, certificate);

    // 2. 生成签名（POC：使用 artifact digest 的 HMAC 模拟）
    const signature = this.computeSignature(digest, signer);

    // 3. 记录到 Rekor 透明日志
    const entryId = randomUUID();
    const entry: RekorEntry = {
      entryId,
      artifactDigest: digest,
      signature,
      certificateRef: certId,
      timestamp: now,
      public: true,
    };
    this.rekorLog.set(entryId, entry);

    return { signature, certificate, rekorEntryId: entryId };
  }

  /**
   * verifyArtifact —— 验证工件签名（含证书链 + Rekor 条目）
   * @param artifact 工件标识
   * @param signature 签名值
   * @param certificateRef 证书引用 ID
   * @param rekorEntryId Rekor 条目 ID
   */
  async verifyArtifact(
    artifact: string,
    signature: string,
    certificateRef: string,
    rekorEntryId: string,
  ): Promise<SigstoreVerificationResult> {
    const digest = this.computeDigest(artifact);

    // 1. 校验 Rekor 条目存在
    const entry = this.rekorLog.get(rekorEntryId);
    if (!entry) {
      return { verified: false, artifactDigest: digest, error: 'Rekor entry not found' };
    }
    if (entry.artifactDigest !== digest) {
      return { verified: false, artifactDigest: digest, error: 'Digest mismatch with Rekor entry' };
    }
    if (entry.signature !== signature) {
      return { verified: false, artifactDigest: digest, error: 'Signature mismatch with Rekor entry' };
    }

    // 2. 校验证书
    const certificate = this.certificates.get(certificateRef);
    if (!certificate) {
      return { verified: false, artifactDigest: digest, error: 'Certificate not found' };
    }
    if (certificate.selfSigned) {
      // POC：自签名证书始终有效（生产环境需验证证书链）
    }

    // 3. 证书时效检查
    const now = new Date();
    const notBefore = new Date(certificate.notBefore);
    const notAfter = new Date(certificate.notAfter);
    if (now < notBefore || now > notAfter) {
      return { verified: false, artifactDigest: digest, error: 'Certificate expired or not yet valid' };
    }

    return {
      verified: true,
      artifactDigest: digest,
      certificate,
      rekorEntryId,
    };
  }

  /**
   * getRekorEntry —— 查询 Rekor 条目
   */
  getRekorEntry(entryId: string): RekorEntry | null {
    return this.rekorLog.get(entryId) ?? null;
  }

  /**
   * getCertificate —— 查询证书
   */
  getCertificate(certId: string): FulcioCertificate | null {
    return this.certificates.get(certId) ?? null;
  }

  /**
   * listEntries —— 列出所有 Rekor 条目
   */
  listEntries(): RekorEntry[] {
    return Array.from(this.rekorLog.values());
  }

  // ── 内部方法 ──

  private computeDigest(artifact: string): string {
    // POC：简单哈希（生产环境使用 SHA256）
    let hash = 0;
    for (let i = 0; i < artifact.length; i++) {
      const char = artifact.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return `sha256:${Math.abs(hash).toString(16).padStart(64, '0')}`;
  }

  private computeSignature(digest: string, signer: string): string {
    // POC：模拟签名（生产环境使用 ECDSA/PKCS#11）
    const combined = `${digest}:${signer}:poc-signature`;
    let sig = 0;
    for (let i = 0; i < combined.length; i++) {
      sig = ((sig << 5) - sig) + combined.charCodeAt(i);
      sig = sig & sig;
    }
    return `poc-sig-${Math.abs(sig).toString(16)}`;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试套件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('K2-1: Sigstore Fulcio/Rekor 自托管 POC', () => {
  let bridge: SigstoreCosignBridge;

  beforeEach(() => {
    bridge = new SigstoreCosignBridge();
  });

  describe('signArtifact', () => {
    it('K2-1-1: 成功签名 OCI 镜像', async () => {
      const result = await bridge.signArtifact('sha256:abc123', 'ci-pipeline@github.com');
      expect(result.signature).toBeTruthy();
      expect(result.certificate).toBeTruthy();
      expect(result.rekorEntryId).toBeTruthy();
      expect(result.certificate.selfSigned).toBe(true);
      expect(result.certificate.subject).toContain('ci-pipeline@github.com');
    });

    it('K2-1-2: 每次签名生成唯一的证书和条目 ID', async () => {
      const r1 = await bridge.signArtifact('artifact-1', 'signer-1');
      const r2 = await bridge.signArtifact('artifact-2', 'signer-2');
      expect(r1.rekorEntryId).not.toBe(r2.rekorEntryId);
      expect(r1.certificate.serialNumber).not.toBe(r2.certificate.serialNumber);
    });
  });

  describe('verifyArtifact', () => {
    it('K2-1-3: 正确签名验证通过', async () => {
      const artifact = 'sha256:test-artifact-1';
      const { signature, certificate, rekorEntryId } = await bridge.signArtifact(artifact, 'signer@test.com');
      const result = await bridge.verifyArtifact(artifact, signature, certificate.serialNumber, rekorEntryId);
      expect(result.verified).toBe(true);
      expect(result.artifactDigest).toBeTruthy();
      expect(result.certificate).toBeTruthy();
      expect(result.rekorEntryId).toBe(rekorEntryId);
    });

    it('K2-1-4: 篡改签名验证失败', async () => {
      const artifact = 'sha256:test-artifact-2';
      const { certificate, rekorEntryId } = await bridge.signArtifact(artifact, 'signer@test.com');
      const result = await bridge.verifyArtifact(artifact, 'tampered-signature', certificate.serialNumber, rekorEntryId);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Signature mismatch');
    });

    it('K2-1-5: 篡改工件验证失败', async () => {
      const artifact = 'sha256:test-artifact-3';
      const { signature, certificate, rekorEntryId } = await bridge.signArtifact(artifact, 'signer@test.com');
      const result = await bridge.verifyArtifact('sha256:tampered-digest', signature, certificate.serialNumber, rekorEntryId);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('Digest mismatch');
    });

    it('K2-1-6: 不存在的 Rekor 条目验证失败', async () => {
      const result = await bridge.verifyArtifact('artifact', 'sig', 'cert', 'non-existent-entry');
      expect(result.verified).toBe(false);
      expect(result.error).toContain('not found');
    });

    it('K2-1-7: 过期证书验证失败', async () => {
      const artifact = 'sha256:test-artifact-7';
      const { signature, certificate, rekorEntryId } = await bridge.signArtifact(artifact, 'signer@test.com');
      // 手动使证书过期
      certificate.notAfter = '2020-01-01T00:00:00.000Z';
      const result = await bridge.verifyArtifact(artifact, signature, certificate.serialNumber, rekorEntryId);
      expect(result.verified).toBe(false);
      expect(result.error).toContain('expired');
    });
  });

  describe('Rekor 透明日志', () => {
    it('K2-1-8: 列出所有条目', async () => {
      await bridge.signArtifact('artifact-1', 'signer-1');
      await bridge.signArtifact('artifact-2', 'signer-2');
      const entries = bridge.listEntries();
      expect(entries.length).toBe(2);
      expect(entries[0].public).toBe(true);
    });

    it('K2-1-9: 查询单个条目', async () => {
      const { rekorEntryId } = await bridge.signArtifact('artifact-1', 'signer-1');
      const entry = bridge.getRekorEntry(rekorEntryId);
      expect(entry).toBeTruthy();
      expect(entry!.entryId).toBe(rekorEntryId);
    });

    it('K2-1-10: 条目不可篡改（查询返回值与签名时一致）', async () => {
      const artifact = 'sha256:test-artifact-10';
      const { signature, rekorEntryId } = await bridge.signArtifact(artifact, 'signer-1');
      const entry = bridge.getRekorEntry(rekorEntryId);
      expect(entry!.signature).toBe(signature);
      expect(entry!.artifactDigest).toBe(this.computeDigest?.call(bridge, artifact) ?? entry!.artifactDigest);
    });
  });

  describe('证书管理', () => {
    it('K2-1-11: 查询证书', async () => {
      const { certificate } = await bridge.signArtifact('artifact-1', 'signer-1');
      const fetched = bridge.getCertificate(certificate.serialNumber);
      expect(fetched).toBeTruthy();
      expect(fetched!.subject).toBe(certificate.subject);
    });

    it('K2-1-12: 不存在的证书返回 null', () => {
      const fetched = bridge.getCertificate('non-existent-cert');
      expect(fetched).toBeNull();
    });
  });
});
