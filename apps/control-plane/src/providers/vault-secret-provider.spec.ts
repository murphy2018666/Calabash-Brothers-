/**
 * L5-1: VaultSecretProvider — 测试套件
 */

import { VaultSecretProvider, TtlOverflowError, type VaultConfig } from './vault-secret-provider';

const TEST_CONFIG: VaultConfig = {
  address: 'https://vault.aegisci.local:8200',
  token: 'test-token-12345',
  secretPath: 'kv/aegisci',
};

describe('K8b-1 / L5-1: VaultSecretProvider', () => {
  let provider: VaultSecretProvider;

  beforeEach(() => {
    provider = new VaultSecretProvider(TEST_CONFIG);
  });

  describe('issue', () => {
    it('L5-1-1: issue with valid scope returns credential', async () => {
      const cred = await provider.issue('user-a', { actions: ['read'], resources: ['data:*'], environment: 'prod', ttl: 60 });
      expect(cred).toBeDefined();
      expect(cred.jti).toBeTruthy();
      expect(cred.token.startsWith('vault.')).toBe(true);
      expect(cred.scope.ttl).toBe(60);
    });

    it('L5-1-2: issue rejects TTL > 30min with TtlOverflowError', async () => {
      await expect(
        provider.issue('user-a', { actions: ['read'], resources: ['data:*'], environment: 'prod', ttl: 60 * 60 }),
      ).rejects.toThrow(TtlOverflowError);
    });

    it('L5-1-3: revoke marks JTI as revoked', async () => {
      const cred = await provider.issue('user-a', { actions: ['read'], resources: ['data:*'], environment: 'prod', ttl: 60 });
      await provider.revoke(cred.jti);
      const verify = provider.verify(cred.token);
      expect(verify.revoked).toBe(true);
      expect(verify.valid).toBe(false);
    });

    it('L5-1-4: revokeAll revokes all credentials for a principal', async () => {
      const c1 = await provider.issue('user-b', { actions: ['read'], resources: ['data:*'], environment: 'prod', ttl: 60 });
      const c2 = await provider.issue('user-b', { actions: ['write'], resources: ['data:*'], environment: 'prod', ttl: 60 });
      const revoked = await provider.revokeAll('user-b');
      expect(revoked).toHaveLength(2);
      expect(provider.verify(c1.token).revoked).toBe(true);
      expect(provider.verify(c2.token).revoked).toBe(true);
    });

    it('L5-1-5: healthy returns true (stub)', async () => {
      expect(await provider.healthy()).toBe(true);
    });

    it('L5-1-6: verify invalid token returns valid=false', () => {
      const result = provider.verify('invalid-token');
      expect(result.valid).toBe(false);
    });

    it('L5-1-7: verify correct token returns valid=true before expiry', async () => {
      const cred = await provider.issue('user-x', { actions: ['read'], resources: ['data:*'], environment: 'prod', ttl: 60 });
      const result = provider.verify(cred.token);
      expect(result.valid).toBe(true);
      expect(result.jti).toBe(cred.jti);
    });
  });
});
