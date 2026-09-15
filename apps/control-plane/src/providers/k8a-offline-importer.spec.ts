/**
 * K8a: 最小离线导入 — 测试套件
 *
 * 覆盖离线包结构校验、签名链验证、幂等导入：
 */

import { OfflinePackageImporter } from './k8a-offline-importer';
import type { OfflinePackage, SkillManifest } from './k8a-offline-importer';

function makeValidManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'test-skill',
    version: '1.0.0',
    description: 'Test skill for offline import',
    author: 'test-author',
    entrypoint: 'entrypoints/test.sh',
    schemaVersion: 1,
    ...overrides,
  };
}

function makeValidPackage(manifest?: SkillManifest): OfflinePackage {
  const m = manifest ?? makeValidManifest();
  const packageId = OfflinePackageImporter.computePackageId(m);
  return {
    manifest: m,
    packageId,
    assets: [
      {
        filename: 'entrypoints/test.sh',
        digest: 'sha256:' + 'a'.repeat(64),
        signature: 'sig_' + 'b'.repeat(32),
        signingTime: new Date().toISOString(),
      },
    ],
  };
}

describe('K8a: Offline Package Import', () => {
  let importer: OfflinePackageImporter;

  beforeEach(() => {
    importer = new OfflinePackageImporter();
  });

  describe('validateManifest', () => {
    it('K8a-1-1: valid manifest passes', () => {
      const errors = OfflinePackageImporter.validateManifest(makeValidManifest());
      expect(errors).toHaveLength(0);
    });

    it('K8a-1-2: missing name fails', () => {
      const errors = OfflinePackageImporter.validateManifest(makeValidManifest({ name: undefined as any }));
      expect(errors.some((e) => e.includes('name'))).toBe(true);
    });

    it('K8a-1-3: missing version fails', () => {
      const errors = OfflinePackageImporter.validateManifest(makeValidManifest({ version: undefined as any }));
      expect(errors.some((e) => e.includes('version'))).toBe(true);
    });

    it('K8a-1-4: missing entrypoint fails', () => {
      const errors = OfflinePackageImporter.validateManifest(makeValidManifest({ entrypoint: undefined as any }));
      expect(errors.some((e) => e.includes('entrypoint'))).toBe(true);
    });

    it('K8a-1-5: unsupported schemaVersion fails', () => {
      const errors = OfflinePackageImporter.validateManifest(makeValidManifest({ schemaVersion: 2 }));
      expect(errors.some((e) => e.includes('schemaVersion'))).toBe(true);
    });
  });

  describe('verifySignatureChain', () => {
    it('K8a-2-1: valid signatures pass', () => {
      const assets = [{
        filename: 'test.sh',
        digest: 'sha256:abc123',
        signature: 'sig_valid',
        signingTime: new Date().toISOString(),
      }];
      const result = OfflinePackageImporter.verifySignatureChain(assets);
      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('K8a-2-2: invalid signature format fails', () => {
      const assets = [{
        filename: 'test.sh',
        digest: 'sha256:abc123',
        signature: 'invalid',
        signingTime: new Date().toISOString(),
      }];
      const result = OfflinePackageImporter.verifySignatureChain(assets);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes('signature') || e.toLowerCase().includes('sig'))).toBe(true);
    });

    it('K8a-2-3: invalid digest format fails', () => {
      const assets = [{
        filename: 'test.sh',
        digest: 'md5:abc123',
        signature: 'sig_valid',
        signingTime: new Date().toISOString(),
      }];
      const result = OfflinePackageImporter.verifySignatureChain(assets);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes('digest') || e.toLowerCase().includes('format'))).toBe(true);
    });
  });

  describe('importPackage', () => {
    it('K8a-3-1: valid package imports successfully', () => {
      const pkg = makeValidPackage();
      const result = importer.importPackage(pkg);
      expect(result.ok).toBe(true);
      expect(result.packageId).toBe(pkg.packageId);
      expect(result.errors).toHaveLength(0);
      expect(importer.isImported(pkg.packageId)).toBe(true);
    });

    it('K8a-3-2: duplicate import returns existing record (idempotent)', () => {
      const pkg = makeValidPackage();
      const r1 = importer.importPackage(pkg);
      const r2 = importer.importPackage(pkg);
      expect(r1.ok).toBe(true);
      expect(r2.ok).toBe(true);
      expect(r2.warnings.some((w) => w.includes('already imported'))).toBe(true);
      expect(r1.importedAt).toBe(r2.importedAt); // 相同时间戳
    });

    it('K8a-3-3: invalid manifest rejected', () => {
      const pkg = makeValidPackage(makeValidManifest({ name: undefined as any }));
      const result = importer.importPackage(pkg);
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
      expect(importer.isImported(pkg.packageId)).toBe(false);
    });

    it('K8a-3-4: invalid signature rejected', () => {
      const pkg = makeValidPackage();
      pkg.assets[0].signature = 'bad-sig';
      const result = importer.importPackage(pkg);
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.toLowerCase().includes('signature') || e.toLowerCase().includes('sig'))).toBe(true);
    });

    it('K8a-3-5: import count tracks correctly', () => {
      const pkg1 = makeValidPackage(makeValidManifest({ name: 'skill-a' }));
      const pkg2 = makeValidPackage(makeValidManifest({ name: 'skill-b' }));
      importer.importPackage(pkg1);
      importer.importPackage(pkg2);
      expect(importer.getImportCount()).toBe(2);
      // 重复导入 pkg1 不增加计数
      importer.importPackage(pkg1);
      expect(importer.getImportCount()).toBe(2);
    });
  });

  describe('computePackageId', () => {
    it('K8a-4-1: deterministic for same name@version', () => {
      const id1 = OfflinePackageImporter.computePackageId(makeValidManifest({ name: 'same', version: '1.0.0' }));
      const id2 = OfflinePackageImporter.computePackageId(makeValidManifest({ name: 'same', version: '1.0.0' }));
      expect(id1).toBe(id2);
    });

    it('K8a-4-2: different name produces different id', () => {
      const id1 = OfflinePackageImporter.computePackageId(makeValidManifest({ name: 'skill-a', version: '1.0.0' }));
      const id2 = OfflinePackageImporter.computePackageId(makeValidManifest({ name: 'skill-b', version: '1.0.0' }));
      expect(id1).not.toBe(id2);
    });
  });
});
