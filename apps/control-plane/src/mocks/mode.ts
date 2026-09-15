/**
 * Mock 模式开关 — AEGISCI_MOCK_MODE
 *
 * 环境变量：AEGISCI_MOCK_MODE
 *   - 未设置 / 'auto'       → 自动检测：NODE_ENV=test 时启用，否则禁用
 *   - 'on'                  → 强制启用 mock 模式
 *   - 'off'                 → 强制禁用 mock 模式（生产默认）
 *   - 'strict'              → 启用 mock 模式并拒绝任何非 mock 的 SPI 实现
 *
 * 影响范围（当 mock 模式启用时）：
 *   1. SPI_DEFAULT_PROVIDERS 中的 TraceExporter → NoopTraceExporter（无论 deployment mode）
 *   2. SPI_DEFAULT_PROVIDERS 中的 SecretProvider → EnvFileSecretProvider
 *   3. SPI_DEFAULT_PROVIDERS 中的 PolicyEngine → EmbeddedPolicyEngine（不切换 OPA）
 *   4. AuthGuard test 的 AGENT_TOKEN_REGISTRY / PRINCIPAL_REPOSITORY 使用 mock 实现
 *
 * 注意：此文件只在生产代码中读取。测试文件中的 jest.fn() 内联 mock 不受此开关控制，
 *       因为它们不经过 DI 容器。
 */

export type MockMode = 'on' | 'off' | 'auto' | 'strict';

const MOCK_MODE_VAR = 'AEGISCI_MOCK_MODE';

/**
 * 获取当前 mock 模式
 */
export function getMockMode(): MockMode {
  const raw = process.env[MOCK_MODE_VAR];
  if (!raw) return 'auto';
  if (raw === 'on' || raw === 'off' || raw === 'strict') return raw;
  return 'auto';
}

/**
 * 判断是否处于 mock 模式（即 AEGISCI_MOCK_MODE=on|strict）。
 * 仅由显式环境变量控制，NODE_ENV=test 不影响结果。
 */
export function isMockMode(): boolean {
  const mode = getMockMode();
  if (mode === 'off') return false;
  return mode === 'on' || mode === 'strict';
}

/**
 * 判断是否应覆盖 SPI 默认实现为 mock 版本。
 * 仅显式设置 AEGISCI_MOCK_MODE=on|strict 时才生效，
 * auto 模式（NODE_ENV=test）不影响 SPI 默认实现选择。
 */
export function shouldUseMockDefaults(): boolean {
  const mode = getMockMode();
  return mode === 'on' || mode === 'strict';
}

/**
 * 断言当前不在 mock 模式（用于生产不变量检查）
 */
export function assertNotMockMode(): void {
  if (isMockMode()) {
    throw new Error(
      `[MockGuard] ${assertNotMockMode.name} 调用失败：当前处于 mock 模式 (${getMockMode()})，` +
      `禁止在此上下文中操作。设置 AEGISCI_MOCK_MODE=off 或 AEGISCI_MOCK_MODE=auto 并确保 NODE_ENV !== test。`,
    );
  }
}
