import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuthorizeRequest, AuthorizeResult } from '@aegisci/shared/types';
import type { SkillRecord } from './skill.service';

/** 评审结论（DES-11.4：lint + SBOM + 注入扫描 + 策略 simulate）。 */
export interface SkillReviewReport {
  readonly skillId: string;
  readonly lint: { passed: boolean; notes: string };
  readonly sbom: { passed: boolean; vulnerabilities: number };
  readonly injectionScan: { passed: boolean; findings: string[] };
  readonly policySimulate: { passed: boolean; decision: string };
  readonly passed: boolean;
}

/** 策略模拟端口 —— 由控制面注入 Decision 子域的 simulate（FR-M3-08）。 */
export const POLICY_SIMULATOR = Symbol('POLICY_SIMULATOR');

export interface PolicySimulator {
  simulate(req: AuthorizeRequest): Promise<AuthorizeResult>;
}

/**
 * Skill 评审流水线服务（DES-11.4）。
 * 四步：清单 schema lint → 依赖 SBOM 扫描 → Prompt 注入静态扫描 → 策略 simulate。
 * 任一步未过 → 整体不通过（回退注册态）。
 */
@Injectable()
export class SkillReviewService {
  private readonly logger = new Logger(SkillReviewService.name);

  constructor(@Inject(POLICY_SIMULATOR) private readonly simulator: PolicySimulator) {}

  async runPipeline(record: SkillRecord): Promise<SkillReviewReport> {
    const lint = this.lint(record);
    const sbom = this.scanSbom(record);
    const injection = this.scanInjection(record);
    const simulate = await this.simulatePolicy(record);

    const passed = lint.passed && sbom.passed && injection.passed && simulate.passed;
    return {
      skillId: record.skillId,
      lint,
      sbom,
      injectionScan: injection,
      policySimulate: simulate,
      passed,
    };
  }

  private lint(record: SkillRecord): { passed: boolean; notes: string } {
    const ok = !!record.manifest.name && !!record.manifest.version && !!record.manifest.type;
    return { passed: ok, notes: ok ? 'manifest schema ok' : 'manifest missing required fields' };
  }

  private scanSbom(record: SkillRecord): { passed: boolean; vulnerabilities: number } {
    // 骨架：真实实现调 Syft/Grype；此处按依赖数静态判定。
    const vulns = record.manifest.dependencies?.length ?? 0;
    return { passed: vulns === 0, vulnerabilities: vulns };
  }

  private scanInjection(record: SkillRecord): { passed: boolean; findings: string[] } {
    const findings: string[] = [];
    const payload = JSON.stringify(record.manifest).toLowerCase();
    if (payload.includes('{{') || payload.includes('ignore previous')) {
      findings.push('possible prompt-injection pattern in manifest');
    }
    return { passed: findings.length === 0, findings };
  }

  private async simulatePolicy(
    record: SkillRecord,
  ): Promise<{ passed: boolean; decision: string }> {
    const req: AuthorizeRequest = {
      principal: {
        id: `skill:${record.skillId}`,
        type: 'service',
        tenantId: record.tenantId,
        roles: [],
      },
      action: 'skill.invoke',
      resource: record.manifest.name,
      context: { riskLevel: record.manifest.riskTier },
    };
    try {
      const result = await this.simulator.simulate(req);
      // 评审期仅 ALLOW 直接通过；HALLOW/DENY 视为需收窄或拒登。
      return { passed: result.decision === 'ALLOW', decision: result.decision };
    } catch (err) {
      this.logger.warn(`policy simulate failed: ${(err as Error).message}`);
      return { passed: false, decision: 'ERROR' };
    }
  }
}
