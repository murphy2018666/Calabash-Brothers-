import { Test, TestingModule } from '@nestjs/testing';
import { DeploymentProfileService } from './deployment-profile.service';
import { SPI_TOKENS } from '@aegisci/core/spi';
import type {
  DeploymentMode,
  ModeSwitchApproval,
  ModeSwitchResult,
} from './deployment-mode';

describe('DeploymentProfileService', () => {
  let service: DeploymentProfileService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [DeploymentProfileService],
    }).compile();
    service = module.get<DeploymentProfileService>(DeploymentProfileService);
  });

  afterEach(() => {
    // 重置环境变量
    delete process.env.AEGISCI_DEPLOYMENT_MODE;
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 基础功能测试
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('should have default mode = standard', () => {
    expect(service.getMode()).toBe('standard');
  });

  it('should read mode from AEGISCI_DEPLOYMENT_MODE env var', () => {
    process.env.AEGISCI_DEPLOYMENT_MODE = 'hardened';
    // 需要重建服务以读取环境变量
    const freshService = new DeploymentProfileService();
    expect(freshService.getMode()).toBe('hardened');
  });

  it('should return correct profile for minimal mode', () => {
    const profile = service.getProfile('minimal');
    expect(profile.mode).toBe('minimal');
    expect(profile.kernelInvariants).toContain('EVERY_TOOL_CALL_AUTHORIZE');
    expect(profile.kernelInvariants).toContain('EVERY_AGENT_ACTION_AUDITED');
    expect(profile.kernelInvariants).toContain('AGENT_COMMUNICATION_VIA_BLACKBOARD');
    // PolicyEngine 必须 required
    const policySpi = profile.requiredSPIs.find(
      (s) => s.token === SPI_TOKENS.POLICY_ENGINE,
    );
    expect(policySpi).toBeDefined();
  });

  it('should return correct profile for standard mode', () => {
    const profile = service.getProfile('standard');
    expect(profile.mode).toBe('standard');
    // Vault 必须 required
    const secretSpi = profile.requiredSPIs.find(
      (s) => s.token === SPI_TOKENS.SECRET_PROVIDER,
    );
    expect(secretSpi).toBeDefined();
    expect(secretSpi?.defaultImplementation).toBe('VaultSecretProvider');
  });

  it('should return correct profile for hardened mode', () => {
    const profile = service.getProfile('hardened');
    expect(profile.mode).toBe('hardened');
    // OPA 必须 required
    const policySpi = profile.requiredSPIs.find(
      (s) => s.token === SPI_TOKENS.POLICY_ENGINE,
    );
    expect(policySpi).toBeDefined();
    expect(policySpi?.defaultImplementation).toBe('OpaPolicyEngine');
    // WORM Trace 必须 required
    const traceSpi = profile.requiredSPIs.find(
      (s) => s.token === SPI_TOKENS.TRACE_EXPORTER,
    );
    expect(traceSpi).toBeDefined();
    expect(traceSpi?.defaultImplementation).toBe('WormTraceExporter');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 底线检查测试
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('should always require PolicyEngine in every mode', () => {
    for (const mode of ['minimal', 'standard', 'hardened'] as DeploymentMode[]) {
      const profile = service.getProfile(mode);
      const policySpi = profile.requiredSPIs.find(
        (s) => s.token === SPI_TOKENS.POLICY_ENGINE,
      );
      expect(policySpi).toBeDefined();
      const modeKeywords: Record<DeploymentMode, string> = {
        minimal: 'minimal',
        standard: 'standard',
        hardened: '高安全',
      };
      expect(policySpi?.description).toContain(modeKeywords[mode]);
    }
  });

  it('should verify kernel invariants pass for all modes', () => {
    for (const mode of ['minimal', 'standard', 'hardened'] as DeploymentMode[]) {
      expect(service.verifyKernelInvariants(mode)).toBe(true);
    }
  });

  it('should include all 3 kernel invariants in every profile', () => {
    for (const mode of ['minimal', 'standard', 'hardened'] as DeploymentMode[]) {
      const profile = service.getProfile(mode);
      expect(profile.kernelInvariants).toHaveLength(3);
      expect(profile.kernelInvariants).toContain('EVERY_TOOL_CALL_AUTHORIZE');
      expect(profile.kernelInvariants).toContain('EVERY_AGENT_ACTION_AUDITED');
      expect(profile.kernelInvariants).toContain('AGENT_COMMUNICATION_VIA_BLACKBOARD');
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 档位切换校验测试
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('should allow same-mode change', () => {
    const result = service.validateModeChange('standard', 'standard');
    expect(result.allowed).toBe(true);
  });

  it('should allow minimal → standard (upgrade)', () => {
    const result = service.validateModeChange('minimal', 'standard');
    expect(result.allowed).toBe(true);
    expect(result.warnings).toBeDefined();
  });

  it('should allow standard → hardened (upgrade)', () => {
    const result = service.validateModeChange('standard', 'hardened');
    expect(result.allowed).toBe(true);
    expect(result.warnings).toBeDefined();
  });

  it('should allow minimal → hardened (jump upgrade)', () => {
    const result = service.validateModeChange('minimal', 'hardened');
    expect(result.allowed).toBe(true);
  });

  it('should deny hardened → minimal without approval', () => {
    const result = service.validateModeChange('hardened', 'minimal');
    expect(result.allowed).toBe(false);
    expect(result.reason).toContain('审批');
  });

  it('should deny hardened → standard without approval', () => {
    const result = service.validateModeChange('hardened', 'standard');
    expect(result.allowed).toBe(false);
  });

  it('should deny standard → minimal without approval', () => {
    const result = service.validateModeChange('standard', 'minimal');
    expect(result.allowed).toBe(false);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 档位切换执行测试
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('should switch to higher mode without approval', () => {
    service.setMode('standard');
    expect(service.getMode()).toBe('standard');

    const result = service.setMode('hardened');
    expect(result.allowed).toBe(true);
    expect(service.getMode()).toBe('hardened');
  });

  it('should switch to lower mode with approval', () => {
    service.setMode('hardened');
    expect(service.getMode()).toBe('hardened');

    const approval: ModeSwitchApproval = {
      approver: 'admin',
      reason: '调试需要',
      approvedAt: Date.now(),
      approvalId: 'test-approval-id',
    };
    const result = service.setMode('standard', approval);
    expect(result.allowed).toBe(true);
    expect(service.getMode()).toBe('standard');
  });

  it('should deny lower mode switch without approval', () => {
    service.setMode('hardened');
    const result = service.setMode('standard');
    expect(result.allowed).toBe(false);
    // 档位未改变
    expect(service.getMode()).toBe('hardened');
  });

  it('should record approval history on downgrade', () => {
    service.setMode('hardened');
    const approval = service.requestApproval('hardened', 'standard', 'admin', 'debug');
    expect(approval.approver).toBe('admin');
    expect(approval.reason).toBe('debug');
    expect(typeof approval.approvalId).toBe('string');
    expect(approval.approvedAt).toBeGreaterThan(0);

    const result = service.setMode('standard', approval);
    expect(result.allowed).toBe(true);
    expect(service.getApprovalHistory()).toHaveLength(1);
  });

  it('should reject approval request for upgrade', () => {
    expect(() =>
      service.requestApproval('minimal', 'standard', 'admin', 'upgrade'),
    ).toThrow('仅降级切换需要审批');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // SPI 列表查询测试
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('should return required SPIs for hardened mode', () => {
    const required = service.getRequiredSPIs('hardened');
    expect(required).toContain(SPI_TOKENS.TRACE_EXPORTER);
    expect(required).toContain(SPI_TOKENS.SECRET_PROVIDER);
    expect(required).toContain(SPI_TOKENS.POLICY_ENGINE);
  });

  it('should return fewer required SPIs for minimal mode', () => {
    const hardenedRequired = service.getRequiredSPIs('hardened').length;
    const minimalRequired = service.getRequiredSPIs('minimal').length;
    expect(minimalRequired).toBeLessThan(hardenedRequired);
  });

  it('should return forbidden SPIs for each mode', () => {
    const forbidden = service.getForbiddenSPIs('standard');
    // Standard 模式下不应该有 forbidden 的 SPI（所有 SPI 都已定义）
    expect(Array.isArray(forbidden)).toBe(true);
  });
});
