/**
 * K8b-2: Cosign Signer — 测试套件
 */

import { CosignSigner, type CosignConfig } from './cosign-signer';

const TEST_CONFIG: CosignConfig = {
  keyless: true,
  oidcIssuer: 'https://accounts.example.com',
  oidcClientId: 'aegisci-cli',
};

describe('K8b-2: CosignSigner', () => {
  let signer: CosignSigner;

  beforeEach(() => {
    signer = new CosignSigner(TEST_CONFIG);
  });

  describe('sign', () => {
    it('K8b-2-10: sign returns ok with valid keyMaterial', () => {
      const result = signer.sign('registry/skills/skill-a:1.0.0', 'valid-key-material');
      expect(result.ok).toBe(true);
      expect(result.signature).toBeTruthy();
      expect(result.signature.startsWith('sig_')).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('K8b-2-11: sign returns error with empty keyMaterial', () => {
      const result = signer.sign('registry/skills/skill-a:1.0.0', '');
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('K8b-2-12: sign includes certificate in keyless mode', () => {
      const result = signer.sign('registry/skills/skill-a:1.0.0', 'valid-key');
      expect(result.certificate).toBeTruthy();
      expect(result.certificate!.startsWith('cert_')).toBe(true);
    });

    it('K8b-2-13: sign does not include certificate in local-key mode', () => {
      const localSigner = new CosignSigner({ keyless: false });
      const result = localSigner.sign('registry/skills/skill-a:1.0.0', 'key123');
      expect(result.certificate).toBeUndefined();
    });
  });

  describe('verify', () => {
    it('K8b-2-14: verify passes for sig_ prefixed signature', () => {
      const result = signer.verify('registry/skills/skill-a:1.0.0', 'sig_abc123');
      expect(result.ok).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('K8b-2-15: verify rejects invalid signature format', () => {
      const result = signer.verify('registry/skills/skill-a:1.0.0', 'invalid-sig');
      expect(result.ok).toBe(false);
      expect(result.errors.length).toBeGreaterThan(0);
    });

    it('K8b-2-16: verify returns certificateIdentity in keyless mode', () => {
      const result = signer.verify('registry/skills/skill-a:1.0.0', 'sig_valid');
      expect(result.certificateIdentity).toBe('https://accounts.example.com');
    });
  });

  describe('verifyWithCert', () => {
    it('K8b-2-17: verifyWithCert passes with matching identity', () => {
      const result = signer.verifyWithCert(
        'registry/skills/skill-a:1.0.0',
        'sig_valid',
        'https://accounts.example.com',
      );
      expect(result.ok).toBe(true);
    });

    it('K8b-2-18: verifyWithCert fails with wrong identity', () => {
      const result = signer.verifyWithCert(
        'registry/skills/skill-a:1.0.0',
        'sig_valid',
        'https://evil.example.com',
      );
      expect(result.ok).toBe(false);
      expect(result.errors.some((e) => e.includes('不匹配'))).toBe(true);
    });
  });
});
