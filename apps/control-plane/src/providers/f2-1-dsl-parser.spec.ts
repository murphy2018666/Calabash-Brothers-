/**
 * F2-1 DSL AST 编译器测试
 *
 * 覆盖 DslCompiler 编译与校验能力：
 * - 有效 DSL 编译为 AST
 * - 无效 DSL 抛出 DslCompileError
 * - validate() 检测规则冲突、重复 ID、非法模式
 */

import { DslCompiler, DslCompileError } from '../providers/dsl-parser';
import type { DslAst, PolicyRule } from '@aegisci/core/spi';

// ── 测试数据工厂 ──────────────────────────────────────────────────────

function makeRule(overrides: Partial<PolicyRule> = {}): PolicyRule {
  return {
    id: 'r1',
    effect: 'allow',
    action: 'tool.exec',
    resource: 'repo/*',
    ...overrides,
  };
}

function makeDslJson(rules: PolicyRule[], version = '1'): string {
  return JSON.stringify({ version, rules });
}

// ── 编译测试 ────────────────────────────────────────────────────────────

describe('F2-1 DslCompiler.compile()', () => {
  it('compiles valid DSL with version and rules', () => {
    const dsl = makeDslJson([
      makeRule({ id: 'r1', effect: 'allow', action: 'tool.exec', resource: 'repo/*' }),
      makeRule({ id: 'r2', effect: 'deny', action: 'tool.exec', resource: 'repo/prod/*' }),
    ]);
    const ast = DslCompiler.compile(dsl);
    expect(ast.version).toBe('1');
    expect(ast.rules).toHaveLength(2);
    expect(ast.rules[0].id).toBe('r1');
    expect(ast.rules[1].id).toBe('r2');
  });

  it('defaults version to "1" when omitted', () => {
    const dsl = JSON.stringify({ rules: [makeRule()] });
    const ast = DslCompiler.compile(dsl);
    expect(ast.version).toBe('1');
  });

  it('parses wildcard action "*" and resource "*"', () => {
    const dsl = makeDslJson([
      makeRule({ action: '*', resource: '*' }),
    ]);
    const ast = DslCompiler.compile(dsl);
    expect(ast.rules[0].action).toBe('*');
    expect(ast.rules[0].resource).toBe('*');
  });

  it('preserves condition field', () => {
    const rule = makeRule({
      condition: { time: { after: '2024-01-01' } },
    });
    const dsl = makeDslJson([rule]);
    const ast = DslCompiler.compile(dsl);
    expect(ast.rules[0].condition).toEqual({ time: { after: '2024-01-01' } });
  });

  it('trims whitespace from id/action/resource', () => {
    const dsl = makeDslJson([
      makeRule({ id: '  r1  ', action: '  tool.exec  ', resource: '  repo/*  ' }),
    ]);
    const ast = DslCompiler.compile(dsl);
    expect(ast.rules[0].id).toBe('r1');
    expect(ast.rules[0].action).toBe('tool.exec');
    expect(ast.rules[0].resource).toBe('repo/*');
  });

  // ── 错误场景 ────────────────────────────────────────────────────────────

  it('throws on invalid JSON', () => {
    expect(() => DslCompiler.compile('{ invalid json')).toThrow(DslCompileError);
  });

  it('throws when root is not an object', () => {
    expect(() => DslCompiler.compile('"just a string"')).toThrow(DslCompileError);
    expect(() => DslCompiler.compile('[]')).toThrow(DslCompileError);
    expect(() => DslCompiler.compile('42')).toThrow(DslCompileError);
  });

  it('throws when rules is missing', () => {
    expect(() => DslCompiler.compile(JSON.stringify({ version: '1' }))).toThrow(DslCompileError);
  });

  it('throws when rules is not an array', () => {
    expect(() => DslCompiler.compile(JSON.stringify({ rules: 'not-array' }))).toThrow(DslCompileError);
  });

  it('throws when a rule has no id', () => {
    const dsl = makeDslJson([{ effect: 'allow', action: 'x', resource: 'y' }]);
    expect(() => DslCompiler.compile(dsl)).toThrow(DslCompileError);
  });

  it('throws when a rule has empty id', () => {
    const dsl = makeDslJson([{ id: '', effect: 'allow', action: 'x', resource: 'y' }]);
    expect(() => DslCompiler.compile(dsl)).toThrow(DslCompileError);
  });

  it('throws when effect is invalid', () => {
    const dsl = makeDslJson([{ id: 'r1', effect: 'maybe', action: 'x', resource: 'y' }]);
    expect(() => DslCompiler.compile(dsl)).toThrow(DslCompileError);
  });

  it('throws when action is missing', () => {
    const dsl = makeDslJson([{ id: 'r1', effect: 'allow', resource: 'y' }]);
    expect(() => DslCompiler.compile(dsl)).toThrow(DslCompileError);
  });

  it('throws when resource is missing', () => {
    const dsl = makeDslJson([{ id: 'r1', effect: 'allow', action: 'x' }]);
    expect(() => DslCompiler.compile(dsl)).toThrow(DslCompileError);
  });

  it('throws when a rule item is not an object', () => {
    const dsl = makeDslJson(['not-an-object'] as unknown as PolicyRule[]);
    expect(() => DslCompiler.compile(dsl)).toThrow(DslCompileError);
  });
});

// ── 校验测试 ────────────────────────────────────────────────────────────

describe('F2-1 DslCompiler.validate()', () => {
  it('returns empty conflicts for clean AST', () => {
    const ast: DslAst = {
      version: '1',
      rules: [
        { id: 'r1', effect: 'allow', action: 'read', resource: 'repo/*' },
        { id: 'r2', effect: 'deny', action: 'write', resource: 'repo/*' },
      ],
    };
    expect(DslCompiler.validate(ast)).toHaveLength(0);
  });

  it('detects duplicate rule ids', () => {
    const ast: DslAst = {
      version: '1',
      rules: [
        { id: 'dup', effect: 'allow', action: 'read', resource: 'repo/*' },
        { id: 'dup', effect: 'deny', action: 'write', resource: 'app/*' },
      ],
    };
    const conflicts = DslCompiler.validate(ast);
    expect(conflicts.some(c => c.includes('duplicate'))).toBe(true);
  });

  it('detects action/resource conflicts between allow and deny rules', () => {
    const ast: DslAst = {
      version: '1',
      rules: [
        { id: 'allow-all', effect: 'allow', action: '*', resource: '*' },
        { id: 'deny-prod', effect: 'deny', action: 'tool.exec', resource: 'repo/prod/*' },
      ],
    };
    const conflicts = DslCompiler.validate(ast);
    expect(conflicts.some(c => c.includes('conflicting'))).toBe(true);
  });

  it('detects same-prefix resource overlap', () => {
    const ast: DslAst = {
      version: '1',
      rules: [
        { id: 'r1', effect: 'allow', action: 'exec', resource: 'repo/*' },
        { id: 'r2', effect: 'deny', action: 'exec', resource: 'repo/prod/*' },
      ],
    };
    const ruleA = ast.rules[0];
    const ruleB = ast.rules[1];
    console.log('DEBUG a.action:', JSON.stringify(ruleA.action), 'b.action:', JSON.stringify(ruleB.action));
    console.log('DEBUG a.effect:', ruleA.effect, 'b.effect:', ruleB.effect);
    console.log('DEBUG a.action === b.action:', ruleA.action === ruleB.action);
    const conflicts = DslCompiler.validate(ast);
    console.log('DEBUG conflicts:', JSON.stringify(conflicts));
    expect(conflicts.some(c => c.includes('conflicting'))).toBe(true);
  });

  it('does not flag same-effect rules as conflicts', () => {
    const ast: DslAst = {
      version: '1',
      rules: [
        { id: 'r1', effect: 'allow', action: 'read', resource: 'repo/*' },
        { id: 'r2', effect: 'allow', action: 'write', resource: 'repo/*' },
      ],
    };
    expect(DslCompiler.validate(ast)).toHaveLength(0);
  });

  it('handles empty rules array', () => {
    const ast: DslAst = { version: '1', rules: [] };
    expect(DslCompiler.validate(ast)).toHaveLength(0);
  });
});
