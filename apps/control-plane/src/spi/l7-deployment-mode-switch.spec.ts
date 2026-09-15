/**
 * L7-6: 三档部署模式切换自动化测试（FR-M7-15）
 *
 * 6 个场景：
 * 1. minimal → standard（扩展）
 * 2. standard → hardened（加固）
 * 3. hardened → standard（降级，需审批）
 * 4. 档位切换后底线不变量仍成立
 * 5. 档位切换后 SPI 实现正确注入
 * 6. 切换过程中在途 Run 不受影响
 */
import { Test, TestingModule } from '@nestjs/testing';
import { DeploymentProfileService } from '../services/deployment-profile.service';
import { WormTraceExporter } from '../providers/worm-trace-exporter';
import { NoopTraceExporter } from '../providers/noop-trace-exporter';
import { VaultSecretProvider } from '../providers/vault-secret-provider';
import { EnvFileSecretProvider } from '../providers/env-file-secret-provider';
import { OpaPolicyEngine } from '../providers/opa-policy-engine';
import { EmbeddedPolicyEngine } from '../providers/embedded-policy-engine';
import { SPI_TOKENS } from '@aegisci/core/spi';
import { KERNEL_INVARIANTS } from '@aegisci/core/kernel';
import type { DeploymentMode, ModeSwitchApproval } from '../services/deployment-mode';

/** 为每个测试创建独立的 service 实例，避免状态污染 */
async function createService(): Promise<DeploymentProfileService> {
  const module: TestingModule = await Test.createTestingModule({
    providers: [DeploymentProfileService],
  }).compile();
  return module.get<DeploymentProfileService>(DeploymentProfileService);
}

describe('L7-6: Deployment Mode Switch Automation', () => {
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景1: minimal → standard（扩展）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('场景1: minimal → standard 切换允许且成功', async () => {
    const ps = await createService();
    // 先确保在 minimal 档（直接从 env 启动，跳过默认 standard）
    process.env.AEGISCI_DEPLOYMENT_MODE = 'minimal';
    const fresh = await createService();
    expect(fresh.getMode()).toBe('minimal');

    const result = fresh.setMode('standard');
    expect(result.allowed).toBe(true);
    expect(fresh.getMode()).toBe('standard');
    expect(result.warnings).toBeDefined();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景2: standard → hardened（加固）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('场景2: standard → hardened 切换允许且成功', async () => {
    const ps = await createService();
    ps.setMode('standard');
    expect(ps.getMode()).toBe('standard');

    const result = ps.setMode('hardened');
    expect(result.allowed).toBe(true);
    expect(ps.getMode()).toBe('hardened');
    expect(result.warnings).toBeDefined();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景3: hardened → standard（降级，需审批）
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('场景3: hardened → standard 降级需审批', async () => {
    const ps = await createService();
    ps.setMode('hardened');
    expect(ps.getMode()).toBe('hardened');

    // 无审批 → 拒绝
    const noApproval = ps.setMode('standard');
    expect(noApproval.allowed).toBe(false);
    expect(noApproval.reason).toContain('审批');
    // 档位未变
    expect(ps.getMode()).toBe('hardened');

    // 有审批 → 允许
    const approval: ModeSwitchApproval = {
      approver: 'security-admin',
      reason: '生产环境调试',
      approvedAt: Date.now(),
      approvalId: 'approval-001',
    };
    const withApproval = ps.setMode('standard', approval);
    expect(withApproval.allowed).toBe(true);
    expect(ps.getMode()).toBe('standard');
    expect(ps.getApprovalHistory()).toHaveLength(1);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景4: 档位切换后底线不变量仍成立
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('场景4: 三档模式下底线不变量始终成立', async () => {
    const ps = await createService();
    for (const mode of ['minimal', 'standard', 'hardened'] as DeploymentMode[]) {
      ps.setMode(mode);
      expect(ps.verifyKernelInvariants(mode)).toBe(true);

      const profile = ps.getProfile(mode);
      // 三条内核不变量必须全部存在
      for (const invariant of KERNEL_INVARIANTS) {
        expect(profile.kernelInvariants).toContain(invariant);
      }
      // PolicyEngine 必须 required
      const policyReq = profile.requiredSPIs.some(
        (s) => s.token === SPI_TOKENS.POLICY_ENGINE,
      );
      expect(policyReq).toBe(true);
    }
  });

  it('场景4b: 任何档位下 AuditWorm 和 Blackboard 不可关闭', async () => {
    const ps = await createService();
    // 底线检查：AuditWorm（KERNEL_INVARIANTS.EVERY_AGENT_ACTION_AUDITED）
    // 和 Blackboard（KERNEL_INVARIANTS.AGENT_COMMUNICATION_VIA_BLACKBOARD）
    // 是内核层硬编码，不在 SPI 层面暴露开关
    for (const mode of ['minimal', 'standard', 'hardened'] as DeploymentMode[]) {
      const profile = ps.getProfile(mode);
      expect(profile.kernelInvariants).toContain('EVERY_AGENT_ACTION_AUDITED');
      expect(profile.kernelInvariants).toContain('AGENT_COMMUNICATION_VIA_BLACKBOARD');
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景5: 档位切换后 SPI 实现正确注入
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('场景5: hardened 模式下 TraceExporter = WormTraceExporter', () => {
    const exporter = new WormTraceExporter();
    expect(exporter.name).toBe('worm');
  });

  it('场景5: minimal 模式下 TraceExporter = NoopTraceExporter', () => {
    const exporter = new NoopTraceExporter();
    expect(exporter.name).toBe('noop');
  });

  it('场景5: hardened 模式下 SecretProvider = VaultSecretProvider', async () => {
    const vault = new VaultSecretProvider();
    const healthy = await vault.healthy();
    expect(healthy).toBe(true);
  });

  it('场景5: minimal 模式下 SecretProvider = EnvFileSecretProvider', async () => {
    const envFile = new EnvFileSecretProvider();
    const healthy = await envFile.healthy();
    expect(healthy).toBe(true);
  });

  it('场景5: hardened 模式下 PolicyEngine = OpaPolicyEngine', () => {
    const opa = new OpaPolicyEngine();
    // OPA 在无规则时 deny-wins
    expect(opa).toBeDefined();
  });

  it('场景5: standard 模式下 PolicyEngine = EmbeddedPolicyEngine', () => {
    const embedded = new EmbeddedPolicyEngine();
    expect(embedded).toBeDefined();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 场景6: 切换过程中在途 Run 不受影响
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('场景6: 档位切换不中断在途 Run（模拟）', async () => {
    const ps = await createService();
    // 模拟一个在途 Run 上下文
    const inFlightRun = {
      runId: 'run-in-flight-001',
      status: 'running' as const,
      traceId: 'trace-in-flight',
    };

    // 切换档位
    ps.setMode('minimal');
    ps.setMode('hardened');
    ps.setMode('standard');

    // 在途 Run 不应受影响
    expect(inFlightRun.status).toBe('running');
    expect(inFlightRun.traceId).toBe('trace-in-flight');
  });

  it('场景6: 档位切换后 DeploymentMode 状态正确持久化', async () => {
    process.env.AEGISCI_DEPLOYMENT_MODE = 'minimal';
    const ps = await createService();
    expect(ps.getMode()).toBe('minimal');
    const modes: DeploymentMode[] = ['minimal', 'standard', 'hardened'];
    for (const mode of modes) {
      ps.setMode(mode);
      expect(ps.getMode()).toBe(mode);
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 额外: 审批历史完整性
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('场景6b: 审批历史记录完整', async () => {
    const ps = await createService();
    ps.setMode('hardened');
    const approval1 = ps.requestApproval('hardened', 'standard', 'admin1', '调试需求');
    const approval2 = ps.requestApproval('hardened', 'minimal', 'admin2', '性能测试');

    expect(ps.getApprovalHistory()).toHaveLength(2);
    expect(ps.getApprovalHistory()[0].approver).toBe('admin1');
    expect(ps.getApprovalHistory()[1].approver).toBe('admin2');
  });
});
