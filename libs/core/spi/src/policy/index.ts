import type { AuthorizeRequest, AuthorizeResult } from '@aegisci/shared/types';

/**
 * PolicyEngineSPI —— 策略求值引擎
 *
 * 不变量（DES-13.9 / DES-5.0 安全交叉保证）：
 * - 默认拒绝语义不变：无匹配规则 = DENY
 * - DENY/HALLOW 输出契约不变：必须返回 evidenceId
 * - 切换引擎后裁决语义一致；回归集 100% 通过（FR-M7-06）
 * - 影响面收窄到 Decision 子域内求值器（DES-5.0）
 *
 * 实现档位：
 * - EmbeddedPolicyEngine —— 内嵌 Cedar 风格 DSL（V1.0 默认）
 * - OpaPolicyEngine —— OPA Sidecar / Rego（P2）
 */

/**
 * PolicyRule —— Cedar 风格 DSL 规则定义（L2-2 引入）。
 *
 * 语义（DES-5.0 / 安全交叉保证）：
 * - effect='deny' 在冲突时优先（deny-wins-on-conflict，fail-closed）
 * - action 支持通配 '*'：匹配任意 action
 * - resource 支持前缀匹配：以 '/*' 结尾时按前缀匹配（'repo/*' → 'repo/x'）
 * - condition 保留扩展位（V1.0 求值器仅按 action+resource 匹配）
 *
 * 规则集语义（与 EmbeddedPolicyEngine.loadRules 对齐）：
 * - 加载为覆盖式（reloadable），调用 loadRules 后旧规则全部失效
 * - 无匹配规则 = DENY（默认拒绝不变量）
 */
export interface PolicyRule {
  /** 规则唯一 ID（写入 evidence.rules 用于追溯） */
  id: string;
  /** 效果：allow 放行 / deny 拒绝（deny 优先） */
  effect: 'allow' | 'deny';
  /** 动作模式：精确字符串或通配 '*' */
  action: string;
  /** 资源模式：精确字符串、'repo/*' 前缀、或 '*' */
  resource: string;
  /** 保留扩展位（V1.0 不参与求值） */
  condition?: Record<string, unknown>;
}

export interface PolicyEngineSPI {
  /** 策略裁决 —— 同步热路径，P95 < 5ms */
  authorize(req: AuthorizeRequest): Promise<AuthorizeResult>;

  /** 策略版本号（缓存键组成部分） */
  getPolicyVersion(): string;

  /** 策略 simulate（FR-M3-08） */
  simulate(req: AuthorizeRequest): Promise<AuthorizeResult>;

  /** 健康检查 */
  healthy(): Promise<boolean>;
}
