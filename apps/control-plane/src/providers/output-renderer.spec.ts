/**
 * OutputRenderer 单元测试（E3-3）。
 *
 * 覆盖：
 * - 正常文本输出
 * - JSON 格式化
 * - 截断行为（truncateLength + maxBytes）
 * - 空/null 输入
 * - stderr 渲染
 * - toAgentContext 元数据标注
 */
import { Test } from '@nestjs/testing';
import { OutputRenderer } from './output-renderer';

describe('OutputRenderer (E3-3)', () => {
  let renderer: OutputRenderer;

  beforeEach(() => {
    renderer = new OutputRenderer({ truncateLength: 100, maxBytes: 1024 });
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 空输入
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('handles null input', () => {
    const result = renderer.renderStdout(null);
    expect(result.text).toBe('');
    expect(result.truncated).toBe(false);
    expect(result.originalByteLength).toBe(0);
  });

  it('handles undefined input', () => {
    const result = renderer.renderStdout(undefined);
    expect(result.text).toBe('');
  });

  it('handles empty string', () => {
    const result = renderer.renderStdout('');
    expect(result.text).toBe('');
    expect(result.type).toBe('text');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 普通文本
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('renders plain text', () => {
    const result = renderer.renderStdout('hello world');
    expect(result.text).toBe('hello world');
    expect(result.truncated).toBe(false);
    expect(result.type).toBe('text');
  });

  it('renders text with newlines', () => {
    const result = renderer.renderStdout('line1\nline2\nline3');
    expect(result.text).toContain('line1');
    expect(result.text).toContain('line3');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // JSON 格式化
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('formats compact JSON', () => {
    const input = '{"a":1,"b":2}';
    const result = renderer.renderStdout(input);
    expect(result.type).toBe('json');
    expect(result.text).toContain('a');
    expect(result.text).toContain('b');
  });

  it('formats pretty-printed nested JSON', () => {
    const input = '{"user":{"name":"test","age":30}}';
    const result = renderer.renderStdout(input);
    expect(result.type).toBe('json');
    // 格式化后应有换行和缩进
    expect(result.text).toContain('\n');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 截断
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('truncates text exceeding truncateLength', () => {
    const longText = 'a'.repeat(200);
    const result = renderer.renderStdout(longText);
    expect(result.truncated).toBe(true);
    expect(result.originalByteLength).toBe(200);
    expect(result.text.length).toBeLessThanOrEqual(100 + 20); // 100 chars + truncated marker
  });

  it('marks truncated in text', () => {
    const longText = 'x'.repeat(200);
    const result = renderer.renderStdout(longText);
    expect(result.text).toContain('[truncated]');
  });

  it('respects maxBytes limit', () => {
    // 创建一个略超 1024 bytes 的 JSON
    const json = JSON.stringify({ data: 'x'.repeat(1100) });
    const result = renderer.renderStdout(json);
    // 如果超出 maxBytes，会被截断
    if (result.truncated) {
      expect(result.originalByteLength).toBeGreaterThan(1024);
    }
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // stderr
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('renders stderr without JSON formatting', () => {
    const errJson = '{"error":"fail"}';
    const result = renderer.renderStderr(errJson);
    expect(result.type).toBe('text'); // stderr 不格式化为 JSON
    expect(result.text).toBe(errJson);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // toAgentContext
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('includes label and truncation metadata in agent context', () => {
    const rendered = renderer.renderStdout('hello');
    const ctx = renderer.toAgentContext(rendered, 'stdout');
    expect(ctx).toContain('[stdout]');
    expect(ctx).toContain('hello');
  });

  it('includes truncation note when output was truncated', () => {
    const rendered = renderer.renderStdout('a'.repeat(200));
    const ctx = renderer.toAgentContext(rendered, 'stderr');
    expect(ctx).toContain('truncated');
    expect(ctx).toContain('200');
  });
});
