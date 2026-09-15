/**
 * Mock 模式开关单元测试（S31-MOCK-1）
 *
 * 覆盖：
 * - getMockMode: 环境变量读取与默认值
 * - isMockMode: 仅由显式 AEGISCI_MOCK_MODE 控制
 * - assertNotMockMode: 生产不变量保护
 * - shouldUseMockDefaults: SPI 默认实现覆盖判断
 */
import { getMockMode, isMockMode, assertNotMockMode, shouldUseMockDefaults, type MockMode } from './mode';

describe('Mock Mode (S31-MOCK-1)', () => {
  const originalEnv = process.env.AEGISCI_MOCK_MODE;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AEGISCI_MOCK_MODE;
    else process.env.AEGISCI_MOCK_MODE = originalEnv;
  });

  // ── getMockMode ──

  it('defaults to auto when env not set', () => {
    delete process.env.AEGISCI_MOCK_MODE;
    expect(getMockMode()).toBe('auto');
  });

  it('returns exact value for valid modes', () => {
    for (const mode of ['on', 'off', 'strict'] as MockMode[]) {
      process.env.AEGISCI_MOCK_MODE = mode;
      expect(getMockMode()).toBe(mode);
    }
  });

  it('ignores invalid values and falls back to auto', () => {
    process.env.AEGISCI_MOCK_MODE = 'invalid';
    expect(getMockMode()).toBe('auto');
  });

  // ── isMockMode ──

  it('false when AEGISCI_MOCK_MODE not set (auto)', () => {
    delete process.env.AEGISCI_MOCK_MODE;
    expect(isMockMode()).toBe(false);
  });

  it('false when AEGISCI_MOCK_MODE=off', () => {
    process.env.AEGISCI_MOCK_MODE = 'off';
    expect(isMockMode()).toBe(false);
  });

  it('true when AEGISCI_MOCK_MODE=on', () => {
    process.env.AEGISCI_MOCK_MODE = 'on';
    expect(isMockMode()).toBe(true);
  });

  it('true when AEGISCI_MOCK_MODE=strict', () => {
    process.env.AEGISCI_MOCK_MODE = 'strict';
    expect(isMockMode()).toBe(true);
  });

  it('ignores invalid values (treats as auto → false)', () => {
    process.env.AEGISCI_MOCK_MODE = 'invalid';
    expect(isMockMode()).toBe(false);
  });

  // ── assertNotMockMode ──

  it('does not throw when not in mock mode', () => {
    process.env.AEGISCI_MOCK_MODE = 'off';
    expect(() => assertNotMockMode()).not.toThrow();
  });

  it('throws when AEGISCI_MOCK_MODE=on', () => {
    process.env.AEGISCI_MOCK_MODE = 'on';
    expect(() => assertNotMockMode()).toThrow(/mock 模式/);
  });

  it('throws when AEGISCI_MOCK_MODE=strict', () => {
    process.env.AEGISCI_MOCK_MODE = 'strict';
    expect(() => assertNotMockMode()).toThrow(/mock 模式/);
  });

  // ── shouldUseMockDefaults ──

  it('false when AEGISCI_MOCK_MODE not set (auto)', () => {
    delete process.env.AEGISCI_MOCK_MODE;
    expect(shouldUseMockDefaults()).toBe(false);
  });

  it('true when AEGISCI_MOCK_MODE=on', () => {
    process.env.AEGISCI_MOCK_MODE = 'on';
    expect(shouldUseMockDefaults()).toBe(true);
  });

  it('true when AEGISCI_MOCK_MODE=strict', () => {
    process.env.AEGISCI_MOCK_MODE = 'strict';
    expect(shouldUseMockDefaults()).toBe(true);
  });
});
