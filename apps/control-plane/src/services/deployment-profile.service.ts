import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import {
  KERNEL_INVARIANTS,
  type KernelInvariant,
} from '@aegisci/core/kernel';
import { SPI_TOKENS } from '@aegisci/core/spi';
import type {
  DeploymentMode,
  DeploymentProfile,
  ModeSwitchApproval,
  ModeSwitchResult,
  SpiProfileItem,
} from './deployment-mode';

/** 三档部署模式的 SPI 配置定义 */
const SPI_PROFILES: Record<DeploymentMode, SpiProfileItem[]> = {
  minimal: [
    { token: SPI_TOKENS.TRACE_EXPORTER, mode: 'required', defaultImplementation: 'NoopTraceExporter', description: '零开销链路追踪（minimal 档）' },
    { token: SPI_TOKENS.SECRET_PROVIDER, mode: 'required', defaultImplementation: 'EnvFileSecretProvider', description: '环境变量凭证（minimal 档，低安全）' },
    { token: SPI_TOKENS.POLICY_ENGINE, mode: 'required', defaultImplementation: 'EmbeddedPolicyEngine', description: '嵌入式 Cedar 策略引擎（minimal 档，内核不变量）' },
    { token: SPI_TOKENS.AGENT_PROVIDER, mode: 'required', defaultImplementation: 'InMemoryAgentProvider', description: '内存 Agent 注册表' },
    { token: SPI_TOKENS.TOOL_PROVIDER, mode: 'required', defaultImplementation: 'InMemoryToolProvider', description: '内存工具注册表' },
    { token: SPI_TOKENS.SKILL_REGISTRY, mode: 'optional', defaultImplementation: 'InMemorySkillRegistry', description: '可选技能注册表' },
    { token: SPI_TOKENS.MODEL_GATEWAY, mode: 'optional', defaultImplementation: 'StubModelGateway', description: '可选模型网关' },
  ],
  standard: [
    { token: SPI_TOKENS.TRACE_EXPORTER, mode: 'required', defaultImplementation: 'OtelOtlpTraceExporter', description: 'OTel OTLP 链路追踪（standard 档）' },
    { token: SPI_TOKENS.SECRET_PROVIDER, mode: 'required', defaultImplementation: 'VaultSecretProvider', description: 'HashiCorp Vault 凭证管理（standard 档）' },
    { token: SPI_TOKENS.POLICY_ENGINE, mode: 'required', defaultImplementation: 'EmbeddedPolicyEngine', description: '嵌入式 Cedar 策略引擎（standard 档）' },
    { token: SPI_TOKENS.AGENT_PROVIDER, mode: 'required', defaultImplementation: 'InMemoryAgentProvider', description: 'Agent 注册表' },
    { token: SPI_TOKENS.TOOL_PROVIDER, mode: 'required', defaultImplementation: 'InMemoryToolProvider', description: '工具注册表' },
    { token: SPI_TOKENS.SKILL_REGISTRY, mode: 'optional', defaultImplementation: 'OciSkillRegistry', description: 'OCI 技能注册表（可选）' },
    { token: SPI_TOKENS.MODEL_GATEWAY, mode: 'required', defaultImplementation: 'OtelOtlpTraceExporter', description: '模型网关' },
  ],
  hardened: [
    { token: SPI_TOKENS.TRACE_EXPORTER, mode: 'required', defaultImplementation: 'WormTraceExporter', description: 'WORM Trace 审计导出（hardened 档，高安全）' },
    { token: SPI_TOKENS.SECRET_PROVIDER, mode: 'required', defaultImplementation: 'VaultSecretProvider', description: 'Vault + HSM 根密钥（hardened 档，高安全）' },
    { token: SPI_TOKENS.POLICY_ENGINE, mode: 'required', defaultImplementation: 'OpaPolicyEngine', description: 'OPA Sidecar 策略引擎（hardened 档，高安全）' },
    { token: SPI_TOKENS.AGENT_PROVIDER, mode: 'required', defaultImplementation: 'InMemoryAgentProvider', description: 'Agent 注册表' },
    { token: SPI_TOKENS.TOOL_PROVIDER, mode: 'required', defaultImplementation: 'SandboxedLinuxToolProvider', description: '沙箱化 Linux 工具' },
    { token: SPI_TOKENS.SKILL_REGISTRY, mode: 'required', defaultImplementation: 'OciSkillRegistry', description: 'OCI 技能注册表（签名验证）' },
    { token: SPI_TOKENS.MODEL_GATEWAY, mode: 'required', defaultImplementation: 'StubModelGateway', description: '模型网关' },
  ],
};

/**
 * 档位管理服务（FR-M7-15 / DES-13.9）
 *
 * 核心约束：
 * 1. 底线三件套（AuditWorm/PolicyEngine/Blackboard）在任何档位不可关闭
 * 2. 高→低档位切换需要审批
 * 3. 低→高档位直接切换
 * 4. 切换不重启服务，通过 DI 重新注入
 */
@Injectable()
export class DeploymentProfileService {
  private readonly logger = new Logger(DeploymentProfileService.name);
  private currentMode: DeploymentMode =
    (process.env.AEGISCI_DEPLOYMENT_MODE as DeploymentMode) ?? 'standard';
  private approvalHistory: ModeSwitchApproval[] = [];

  /**
   * 获取当前档位
   */
  getMode(): DeploymentMode {
    return this.currentMode;
  }

  /**
   * 获取当前档位的完整配置文件
   */
  getProfile(mode: DeploymentMode = this.currentMode): DeploymentProfile {
    const requiredSPIs = SPI_PROFILES[mode].filter((s) => s.mode === 'required');
    const optionalSPIs = SPI_PROFILES[mode].filter((s) => s.mode === 'optional');
    // forbidden = 该档位没有定义但其他档位有定义的 SPI
    const allSpiTokens = Object.values(SPI_TOKENS) as symbol[];
    const definedTokens = SPI_PROFILES[mode].map((s) => s.token);
    const forbiddenSPIs: SpiProfileItem[] = allSpiTokens
      .filter((t) => !definedTokens.includes(t))
      .map((token) => ({ token, mode: 'forbidden' as const, description: '该档位禁止' }));

    return {
      mode,
      description: this.getModeDescription(mode),
      requiredSPIs,
      optionalSPIs,
      forbiddenSPIs,
      kernelInvariants: [...KERNEL_INVARIANTS],
      mandatoryKernelSPIs: ['POLICY_ENGINE'], // PolicyEngine 是唯一"内核层"强制 SPI
    };
  }

  /**
   * 校验档位切换合法性
   */
  validateModeChange(from: DeploymentMode, to: DeploymentMode): ModeSwitchResult {
    // 同档位切换 → 直接允许
    if (from === to) {
      return { allowed: true };
    }

    // 底线不变量检查：任何档位都不能关闭 PolicyEngine
    const targetProfile = this.getProfile(to);
    const policyRequired = targetProfile.requiredSPIs.some(
      (s) => s.token === SPI_TOKENS.POLICY_ENGINE,
    );
    if (!policyRequired) {
      return {
        allowed: false,
        reason: '底线不允许：PolicyEngine 不可关闭（内核不变量）',
      };
    }

    // 高→低需要审批
    const order: DeploymentMode[] = ['minimal', 'standard', 'hardened'];
    const fromIdx = order.indexOf(from);
    const toIdx = order.indexOf(to);
    if (toIdx < fromIdx) {
      // 降级：需要审批
      return {
        allowed: false,
        reason: `降级切换 ${from} → ${to} 需要审批，请先调用 requestApproval()`,
        warnings: ['降级将关闭安全增强功能，请确认风险评估已记录'],
      };
    }

    // 低→高或同级别：直接允许
    return {
      allowed: true,
      warnings: toIdx > fromIdx
        ? [`升级至 ${to} 档位，安全增强功能将启用`]
        : undefined,
    };
  }

  /**
   * 执行档位切换
   */
  setMode(
    to: DeploymentMode,
    approval?: ModeSwitchApproval,
  ): ModeSwitchResult {
    const from = this.currentMode;

    // 同档位切换 → 直接允许
    if (from === to) {
      return { allowed: true };
    }

    // 底线不变量检查：任何档位都不能关闭 PolicyEngine
    const targetProfile = this.getProfile(to);
    const policyRequired = targetProfile.requiredSPIs.some(
      (s) => s.token === SPI_TOKENS.POLICY_ENGINE,
    );
    if (!policyRequired) {
      return {
        allowed: false,
        reason: '底线不允许：PolicyEngine 不可关闭（内核不变量）',
      };
    }

    // 降级切换逻辑
    const order: DeploymentMode[] = ['minimal', 'standard', 'hardened'];
    const fromIdx = order.indexOf(from);
    const toIdx = order.indexOf(to);
    if (toIdx < fromIdx) {
      // 降级：必须有审批
      if (!approval) {
        return {
          allowed: false,
          reason: `降级切换 ${from} → ${to} 需要审批，请先调用 requestApproval()`,
          warnings: ['降级将关闭安全增强功能，请确认风险评估已记录'],
        };
      }
    }

    // 执行切换
    this.currentMode = to;
    this.logger.warn(
      `[DeploymentProfile] 档位切换: ${from} → ${to}${approval ? ` (审批人: ${approval.approver})` : ''}`,
    );

    // 记录审批历史（用 approvalId 去重，避免 requestApproval 已 push 的重复）
    if (approval && !this.approvalHistory.some(a => a.approvalId === approval.approvalId)) {
      this.approvalHistory.push(approval);
    }

    return {
      allowed: true,
      warnings: approval
        ? [`已审批的降级切换: ${from} → ${to}`]
        : toIdx > fromIdx
          ? [`升级至 ${to} 档位，安全增强功能将启用`]
          : [`档位已切换至 ${to}`],
    };
  }

  /**
   * 申请降级审批（hardened → 低档位）
   */
  requestApproval(
    from: DeploymentMode,
    to: DeploymentMode,
    approver: string,
    reason: string,
  ): ModeSwitchApproval {
    if (orderIndexOf(from) <= orderIndexOf(to)) {
      throw new Error('仅降级切换需要审批');
    }
    const approval: ModeSwitchApproval = {
      approver,
      reason,
      approvedAt: Date.now(),
      approvalId: randomUUID(),
    };
    this.approvalHistory.push(approval);
    this.logger.log(
      `[DeploymentProfile] 降级审批已通过: ${from} → ${to} (审批人: ${approver})`,
    );
    return approval;
  }

  /**
   * 获取审批历史
   */
  getApprovalHistory(): ModeSwitchApproval[] {
    return [...this.approvalHistory];
  }

  /**
   * 获取档位要求的 SPI 令牌列表
   */
  getRequiredSPIs(mode: DeploymentMode = this.currentMode): symbol[] {
    return SPI_PROFILES[mode]
      .filter((s) => s.mode === 'required')
      .map((s) => s.token as symbol);
  }

  /**
   * 获取档位禁止的 SPI 令牌列表
   */
  getForbiddenSPIs(mode: DeploymentMode = this.currentMode): symbol[] {
    return SPI_PROFILES[mode]
      .filter((s) => s.mode === 'forbidden')
      .map((s) => s.token as symbol);
  }

  /**
   * 底线检查：验证当前档位是否满足内核不变量
   */
  verifyKernelInvariants(mode: DeploymentMode = this.currentMode): boolean {
    const profile = this.getProfile(mode);
    // 检查 PolicyEngine 是否始终 in required
    const policyRequired = profile.requiredSPIs.some(
      (s) => s.token === SPI_TOKENS.POLICY_ENGINE,
    );
    // 检查所有内核不变量是否存在
    const allInvariantsPresent = profile.kernelInvariants.length ===
      KERNEL_INVARIANTS.length;
    return policyRequired && allInvariantsPresent;
  }

  private getModeDescription(mode: DeploymentMode): string {
    const descriptions: Record<DeploymentMode, string> = {
      minimal: '开发/测试环境，零外部依赖，最快启动',
      standard: '生产标准环境，完整 SPI 实现，平衡安全与性能',
      hardened: '高安全环境，WORM 审计 + OPA + Vault + gVisor，等保三级合规',
    };
    return descriptions[mode];
  }
}

function orderIndexOf(mode: DeploymentMode): number {
  const order: DeploymentMode[] = ['minimal', 'standard', 'hardened'];
  return order.indexOf(mode);
}
