import { randomUUID } from 'crypto';
import { EnvFileSecretProvider } from './env-file-secret-provider';

/**
 * TC-PERM-KEY-01~02 —— 租户密钥销毁（密码学擦除验证）。
 *
 * SaaS 逻辑隔离前提：租户密钥吊销后，该租户所有凭证必须不可再用，
 * 且不能影响其他租户的正常凭证。
 * 对应等保三级 8.3.2 访问控制 + 8.3.3 安全审计。
 */
describe('TC-PERM-KEY: 租户密钥销毁路径', () => {
  let provider: EnvFileSecretProvider;

  const makeScope = () => ({
    actions: ['git.read', 'pipeline.run'],
    resources: ['refs/heads/main'],
    environment: 'prod',
    ttl: 300,
  });

  beforeEach(() => {
    provider = new EnvFileSecretProvider();
  });

  // TC-PERM-KEY-01：租户 A 密钥销毁后，租户 A 的所有凭证不可再用
  it('TC-PERM-KEY-01: revokeAll(tenantA) invalidates all tokens for that tenant only', async () => {
    // 签发 agent-A（同 principal）和 agent-B（不同 principal）的凭证
    const agentA = await provider.issue('agent-A', makeScope());
    const agentA2 = await provider.issue('agent-A', makeScope());
    const agentB = await provider.issue('agent-B', makeScope());

    // 吊销前均有效
    expect(provider.verify(agentA.token).valid).toBe(true);
    expect(provider.verify(agentA2.token).valid).toBe(true);
    expect(provider.verify(agentB.token).valid).toBe(true);

    // 吊销 agent-A 的所有凭证
    const revokedJtis = await provider.revokeAll('agent-A');
    expect(revokedJtis).toContain(agentA.jti);
    expect(revokedJtis).toContain(agentA2.jti);
    expect(revokedJtis).not.toContain(agentB.jti);

    // agent-A 的凭证全部失效
    expect(provider.verify(agentA.token).valid).toBe(false);
    expect(provider.verify(agentA.token).revoked).toBe(true);
    expect(provider.verify(agentA2.token).valid).toBe(false);
    expect(provider.verify(agentA2.token).revoked).toBe(true);

    // agent-B 的凭证仍然有效（跨租户隔离）
    expect(provider.verify(agentB.token).valid).toBe(true);
    expect(provider.verify(agentB.token).revoked).toBe(false);
  });

  // TC-PERM-KEY-02：单凭证吊销后，仅该凭证失效，其余凭证不受影响
  it('TC-PERM-KEY-02: single revoke only invalidates that specific JTI', async () => {
    const token1 = await provider.issue('agent-x', makeScope());
    const token2 = await provider.issue('agent-x', makeScope());
    const token3 = await provider.issue('agent-y', makeScope());

    expect(provider.verify(token1.token).valid).toBe(true);
    expect(provider.verify(token2.token).valid).toBe(true);
    expect(provider.verify(token3.token).valid).toBe(true);

    // 仅吊销 token1
    await provider.revoke(token1.jti);

    // token1 失效
    expect(provider.verify(token1.token).valid).toBe(false);
    expect(provider.verify(token1.token).revoked).toBe(true);

    // token2 和 token3 不受影响（同一 principal 和其他 principal）
    expect(provider.verify(token2.token).valid).toBe(true);
    expect(provider.verify(token2.token).revoked).toBe(false);
    expect(provider.verify(token3.token).valid).toBe(true);
    expect(provider.verify(token3.token).revoked).toBe(false);
  });

  // TC-PERM-KEY-03：吊销后凭证不可通过重新 issue 恢复（幂等性）
  it('TC-PERM-KEY-03: revoked token remains revoked after multiple revocations', async () => {
    const cred = await provider.issue('agent-z', makeScope());
    const originalJti = cred.jti;

    await provider.revoke(originalJti);
    expect(provider.verify(cred.token).valid).toBe(false);

    // 重复吊销不改变状态
    await provider.revoke(originalJti);
    await provider.revoke(originalJti);
    expect(provider.verify(cred.token).valid).toBe(false);
    expect(provider.verify(cred.token).revoked).toBe(true);
    expect(provider.verify(cred.token).jti).toBe(originalJti);
  });

  // TC-PERM-KEY-04：空吊销操作不抛出异常
  it('TC-PERM-KEY-04: revoke/revokeAll on empty registry is safe', async () => {
    await expect(provider.revoke(randomUUID())).resolves.toBeUndefined();
    expect(await provider.revokeAll('nonexistent')).toEqual([]);
  });
});
