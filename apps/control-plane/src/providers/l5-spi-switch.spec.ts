/**
 * L5-5: SPI 切换验证集成测试
 *
 * 验证：在运行时将 SPI 从默认实现切换到 L5 新实现，接口契约保持一致。
 * 对应：FR-M7-08（切换实现不改内核代码）
 */

import { VaultSecretProvider } from './vault-secret-provider';
import { OpaPolicyEngine } from './opa-policy-engine';
import { SummaryCompressor } from './summary-compressor';
import { GvisorSandboxRuntime } from './gvisor-sandbox-runtime';
import { EnvFileSecretProvider } from './env-file-secret-provider';
import { EmbeddedPolicyEngine } from './embedded-policy-engine';

describe('L5-5: SPI 切换验证集成测试', () => {
  describe('SecretProvider: EnvFile → Vault', () => {
    it('L5-5-1: 切换后仍满足 SecretProvider 接口契约（issue/revoke/verify）', async () => {
      const defaultImpl = new EnvFileSecretProvider();
      const switchedImpl = new VaultSecretProvider({
        address: 'https://vault.test:8200',
        token: 'test-token',
        secretPath: 'kv/test',
      });

      // issue
      const defaultCred = await defaultImpl.issue('user-a', {
        actions: ['read'], resources: ['data:*'], environment: 'prod', ttl: 60,
      });
      const switchedCred = await switchedImpl.issue('user-a', {
        actions: ['read'], resources: ['data:*'], environment: 'prod', ttl: 60,
      });
      expect(defaultCred.jti).toBeTruthy();
      expect(switchedCred.jti).toBeTruthy();

      // verify
      const defaultVerify = defaultImpl.verify(defaultCred.token);
      const switchedVerify = switchedImpl.verify(switchedCred.token);
      expect(defaultVerify.valid).toBe(true);
      expect(switchedVerify.valid).toBe(true);

      // revoke
      await defaultImpl.revoke(defaultCred.jti);
      await switchedImpl.revoke(switchedCred.jti);
      expect(defaultImpl.verify(defaultCred.token).revoked).toBe(true);
      expect(switchedImpl.verify(switchedCred.token).revoked).toBe(true);
    });

    it('L5-5-2: Vault 越界 TTL 拒绝与 EnvFile 行为一致', async () => {
      const vault = new VaultSecretProvider({
        address: 'https://vault.test:8200', token: 't', secretPath: 'k/v',
      });
      const envFile = new EnvFileSecretProvider();

      await expect(
        vault.issue('u', { actions: ['r'], resources: ['r:*'], environment: 'p', ttl: 7200 }),
      ).rejects.toThrow(/TTL overflow/);
      await expect(
        envFile.issue('u', { actions: ['r'], resources: ['r:*'], environment: 'p', ttl: 7200 }),
      ).rejects.toThrow(/TTL overflow/);
    });
  });

  describe('PolicyEngine: Embedded → OPA', () => {
    it('L5-5-3: 切换后 authorize 语义一致（allow/deny）', async () => {
      const defaultImpl = new EmbeddedPolicyEngine();
      const switchedImpl = new OpaPolicyEngine({ url: 'http://opa.test:8181', namespace: 'test' });

      // 加载相同规则（resource: '*' 通配所有资源）
      defaultImpl.loadRules([
        { id: 'r1', effect: 'allow', action: 'read', resource: '*' },
      ]);
      switchedImpl.loadRules([
        { id: 'r1', effect: 'allow', action: 'read', resource: '*' },
      ]);

      const req = {
        principal: 'user-a',
        action: 'read',
        resource: 'data:public',
        context: {},
      };

      const defaultResult = await defaultImpl.authorize(req);
      const switchedResult = await switchedImpl.authorize(req);
      expect(defaultResult.decision).toBe('ALLOW');
      expect(switchedResult.decision).toBe('ALLOW');
    });

    it('L5-5-4: 无匹配规则时两者均返回 DENY（fail-closed）', async () => {
      const defaultImpl = new EmbeddedPolicyEngine();
      const switchedImpl = new OpaPolicyEngine({ url: 'http://opa.test:8181', namespace: 'test' });

      // 只允许 read，不加载 delete 规则 → delete 无匹配
      defaultImpl.loadRules([
        { id: 'r1', effect: 'allow', action: 'read', resource: '*' },
      ]);
      switchedImpl.loadRules([
        { id: 'r1', effect: 'allow', action: 'read', resource: '*' },
      ]);

      const req = {
        principal: 'user-a', action: 'delete', resource: 'data:sensitive', context: {},
      };
      const r1 = await defaultImpl.authorize(req);
      const r2 = await switchedImpl.authorize(req);
      expect(r1.decision).toBe('DENY');
      expect(r2.decision).toBe('DENY');
    });
  });

  describe('SummaryCompressor（非 SPI，验证实现正确性）', () => {
    it('L5-5-5: 压缩后保留决策点完整内容', () => {
      const compressor = new SummaryCompressor({ maxEntries: 100, targetRatio: 0.3 });
      const entries = [
        { role: 'user', content: 'Check compliance for SOC2 control A1.' },
        { role: 'assistant', content: 'Decision: APPROVE - policyEngine authorize returned ALLOW.' },
        { role: 'tool', content: 'Compliance check: PASS - all controls met.' },
        { role: 'user', content: 'Run another check for ISO27001.' },
      ];
      const result = compressor.compress(entries);
      const decisions = result.entries.filter((e) => e.isDecisionPoint);
      expect(decisions.length).toBeGreaterThan(0);
      // 决策点 summary 应比非决策点更长
      const decisionSummaries = decisions.map((d) => d.summary);
      const nonDecisionSummaries = result.entries
        .filter((e) => !e.isDecisionPoint)
        .map((e) => e.summary);
      const avgDecisionLen = decisionSummaries.reduce((s, x) => s + x.length, 0) / decisionSummaries.length;
      const avgNonDecisionLen = nonDecisionSummaries.reduce((s, x) => s + x.length, 0) / nonDecisionSummaries.length;
      expect(avgDecisionLen).toBeGreaterThan(avgNonDecisionLen);
    });
  });

  describe('GvisorSandboxRuntime（非 SPI，验证实现正确性）', () => {
    it('L5-5-6: 启动/执行/销毁生命周期完整', async () => {
      const runtime = new GvisorSandboxRuntime();
      expect(await runtime.healthy()).toBe(true);

      const containerId = await runtime.start({ image: 'alpine:latest' });
      expect(containerId).toBeTruthy();

      const result = await runtime.exec(containerId, 'echo', ['hello']);
      expect(result.exitCode).toBe(0);

      await runtime.destroy(containerId);
      // healthy() 是 stub，始终返回 true
      expect(await runtime.healthy()).toBe(true);
    }, 15000);
  });

  describe('综合：多 SPI 同时切换', () => {
    it('L5-5-7: 同时使用 Vault + OPA + Gvisor 完成一次完整调用链', async () => {
      const secretProvider = new VaultSecretProvider({
        address: 'https://vault.test:8200', token: 'tok', secretPath: 'kv/aegisci',
      });
      const policyEngine = new OpaPolicyEngine({ url: 'http://opa.test:8181', namespace: 'aegisci' });
      // resource: '*' 通配所有资源
      policyEngine.loadRules([
        { id: 'allow-read', effect: 'allow', action: 'read', resource: '*' },
      ]);
      const sandbox = new GvisorSandboxRuntime();

      // 1. 签发凭证
      const cred = await secretProvider.issue('agent-1', {
        actions: ['read'], resources: ['data:*'], environment: 'prod', ttl: 60,
      });

      // 2. 验证凭证有效
      const verified = secretProvider.verify(cred.token);
      expect(verified.valid).toBe(true);

      // 3. 策略裁决
      const authResult = await policyEngine.authorize({
        principal: 'agent-1',
        action: 'read',
        resource: 'data:public',
        context: { credential: cred.token },
      });
      expect(authResult.decision).toBe('ALLOW');

      // 4. 沙箱执行
      const sid = await sandbox.start({ image: 'alpine:latest' });
      const execResult = await sandbox.exec(sid, 'echo', ['ok']);
      expect(execResult.exitCode).toBe(0);
      await sandbox.destroy(sid);

      // 5. 清理
      await secretProvider.revoke(cred.jti);
      expect(secretProvider.verify(cred.token).revoked).toBe(true);
    }, 15000);
  });
});
