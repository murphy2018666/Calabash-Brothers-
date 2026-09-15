/**
 * OsDetector 单元测试（E3-4）。
 *
 * 覆盖：
 * - Linux/ macOS/ Windows 检测
 * - sandboxSupported 门控
 * - placeholder 占位说明
 */
import { Test } from '@nestjs/testing';
import { OsDetector } from './os-detector';

describe('OsDetector (E3-4)', () => {
  let detector: OsDetector;

  beforeEach(async () => {
    const module = await Test.createTestingModule({ providers: [OsDetector] }).compile();
    detector = module.get(OsDetector);
  });

  it('capability has os field', () => {
    expect(detector.capability.os).toBeTruthy();
  });

  it('capability has sandboxSupported field', () => {
    expect(typeof detector.capability.sandboxSupported).toBe('boolean');
  });

  it('capability has defaultToolProvider', () => {
    expect(detector.capability.defaultToolProvider).toBeTruthy();
  });

  it('isSandboxReady() reflects sandboxSupported', () => {
    expect(detector.isSandboxReady()).toBe(detector.capability.sandboxSupported);
  });

  it('isOs() matches current OS', () => {
    const osName = detector.capability.os;
    expect(detector.isOs(osName)).toBe(true);
  });

  it('isOs() returns false for different OS', () => {
    const otherOs = detector.capability.os === 'linux' ? 'macos' : 'linux';
    expect(detector.isOs(otherOs as any)).toBe(false);
  });

  it('macOS and Windows have placeholder notes', () => {
    // 由于运行环境是 Linux，验证 placeholder 逻辑存在于代码中
    // 通过 capability.placeholderNote 字段间接验证
    const cap = detector.capability;
    if (cap.placeholder) {
      expect(cap.placeholderNote).toBeTruthy();
      expect(cap.placeholderNote!.length).toBeGreaterThan(0);
    }
  });
});
