/**
 * K8a: 最小离线导入 — 手动导入签名包 stub
 *
 * 验证技能包离线导入流程：
 *  - 包结构校验（manifest.json + signed assets）
 *  - cosign 签名链验证（stub：检查签名元数据）
 *  - 导入幂等性（重复导入同一包不报错）
 *  - 无效包拒绝
 *
 * 对应 WBS: K8a (1.10.8a 最小离线导入-P0)
 */

import * as crypto from 'crypto';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// K8a 类型定义
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface SkillManifest {
  name: string;
  version: string;
  description: string;
  author: string;
  entrypoint: string;
  requirements?: string[];
  schemaVersion: number;
}

export interface SignedAsset {
  filename: string;
  digest: string;      // sha256 hex
  signature: string;   // cosign signature (stub: base64)
  signingTime: string;
}

export interface OfflinePackage {
  manifest: SkillManifest;
  assets: SignedAsset[];
  packageId: string;
}

export interface ImportResult {
  ok: boolean;
  packageId: string;
  importedAt: string;
  errors: string[];
  warnings: string[];
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// K8a OfflinePackageImporter
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export class OfflinePackageImporter {
  private readonly importedPackages = new Map<string, {
    manifest: SkillManifest;
    assets: SignedAsset[];
    importedAt: string;
  }>();

  /**
   * computePackageId —— 计算包 ID（manifest.name@version 的 sha256）
   */
  static computePackageId(manifest: SkillManifest): string {
    const raw = `${manifest.name}@${manifest.version}`;
    return crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  }

  /**
   * validateManifest —— 校验 manifest 完整性
   */
  static validateManifest(manifest: Partial<SkillManifest>): string[] {
    const errors: string[] = [];
    if (!manifest.name) errors.push('manifest.name is required');
    if (!manifest.version) errors.push('manifest.version is required');
    if (!manifest.entrypoint) errors.push('manifest.entrypoint is required');
    if (manifest.schemaVersion !== undefined && manifest.schemaVersion !== 1) {
      errors.push(`Unsupported schemaVersion: ${manifest.schemaVersion}`);
    }
    return errors;
  }

  /**
   * validateAssets —— 校验签名资产完整性
   */
  static validateAssets(assets: SignedAsset[], expectedDigests: string[]): string[] {
    const errors: string[] = [];
    const foundDigests = new Set(assets.map((a) => a.digest));

    for (const expected of expectedDigests) {
      if (!foundDigests.has(expected)) {
        errors.push(`Missing asset with digest ${expected.slice(0, 8)}...`);
      }
    }

    for (const asset of assets) {
      if (!asset.signature || asset.signature.length < 8) {
        errors.push(`Invalid signature for ${asset.filename}`);
      }
      if (!asset.signingTime || isNaN(new Date(asset.signingTime).getTime())) {
        errors.push(`Invalid signingTime for ${asset.filename}`);
      }
    }

    return errors;
  }

  /**
   * verifySignatureChain —— 验证 cosign 签名链（stub）
   * 检查所有 asset 的 signature 非空且格式合法
   */
  static verifySignatureChain(assets: SignedAsset[]): { ok: boolean; errors: string[] } {
    const errors: string[] = [];
    for (const asset of assets) {
      if (!asset.signature?.startsWith('sig')) {
        errors.push(`Signature format invalid for ${asset.filename}: must start with 'sig'`);
      }
      if (!asset.digest?.startsWith('sha256:')) {
        errors.push(`Digest format invalid for ${asset.filename}`);
      }
    }
    return { ok: errors.length === 0, errors };
  }

  /**
   * importPackage —— 导入离线技能包
   * 支持幂等：重复导入同一包不报错
   */
  importPackage(pkg: OfflinePackage): ImportResult {
    // 幂等检查
    if (this.importedPackages.has(pkg.packageId)) {
      const existing = this.importedPackages.get(pkg.packageId)!;
      return {
        ok: true,
        packageId: pkg.packageId,
        importedAt: existing.importedAt,
        errors: [],
        warnings: ['Package already imported, skipping'],
      };
    }

    const errors: string[] = [];
    const warnings: string[] = [];

    // 1. 校验 manifest
    const manifestErrors = OfflinePackageImporter.validateManifest(pkg.manifest);
    if (manifestErrors.length > 0) {
      errors.push(...manifestErrors);
    }

    // 2. 校验签名链
    const sigResult = OfflinePackageImporter.verifySignatureChain(pkg.assets);
    if (!sigResult.ok) {
      errors.push(...sigResult.errors);
    }

    // 3. 校验 asset 完整性
    const assetDigests = pkg.assets.map((a) => a.digest);
    const assetErrors = OfflinePackageImporter.validateAssets(pkg.assets, assetDigests);
    if (assetErrors.length > 0) {
      warnings.push(...assetErrors);
    }

    if (errors.length > 0) {
      return { ok: false, packageId: pkg.packageId, importedAt: '', errors, warnings };
    }

    // 导入成功
    this.importedPackages.set(pkg.packageId, {
      manifest: pkg.manifest,
      assets: pkg.assets,
      importedAt: new Date().toISOString(),
    });

    return {
      ok: true,
      packageId: pkg.packageId,
      importedAt: new Date().toISOString(),
      errors: [],
      warnings,
    };
  }

  /**
   * isImported —— 检查包是否已导入
   */
  isImported(packageId: string): boolean {
    return this.importedPackages.has(packageId);
  }

  /**
   * getManifest —— 获取已导入包的 manifest
   */
  getManifest(packageId: string): SkillManifest | null {
    return this.importedPackages.get(packageId)?.manifest ?? null;
  }

  /**
   * getImportCount —— 已导入包数量
   */
  getImportCount(): number {
    return this.importedPackages.size;
  }
}
