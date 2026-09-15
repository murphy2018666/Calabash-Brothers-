import type { PolicyRule } from '@aegisci/core/spi';

/**
 * DSL 编译错误 —— DSL 文法解析失败时抛出。
 */
export class DslCompileError extends Error {
  constructor(
    message: string,
    public readonly line?: number,
    public readonly column?: number,
  ) {
    super(message);
    this.name = 'DslCompileError';
  }
}

/**
 * DSL AST 节点 —— 策略文件经编译器解析后的抽象语法树。
 *
 * 当前支持 Cedar 风格基础 DSL：
 * - policy: { version, rules: [...PolicyRule] }
 * - 每个 rule 包含 id / effect / action / resource / condition
 */
export interface DslAst {
  version: string;
  rules: PolicyRule[];
}

/**
 * DSL 编译器 —— 将 JSON 字符串解析为 PolicyRule[] AST。
 *
 * 支持的文法（Cedar 风格基础）：
 * ```json
 * {
 *   "version": "1",
 *   "rules": [
 *     { "id": "allow-exec", "effect": "allow", "action": "tool.exec", "resource": "repo/*" },
 *     { "id": "deny-prod",  "effect": "deny",  "action": "tool.exec", "resource": "repo/prod/*" }
 *   ]
 * }
 * ```
 *
 * 校验规则：
 * - rules 必须为非空数组
 * - 每个 rule 必须有 id（非空字符串）和 effect（allow | deny）
 * - action 必须是 '*' 或字母数字/点/下划线/连字符组成的模式
 * - resource 必须是 '*'、'prefix/*' 前缀模式、或精确字符串
 */
export class DslCompiler {
  /**
   * 编译 DSL JSON 字符串为 AST。
   * @throws DslCompileError 当 JSON 格式无效或语义校验失败时。
   */
  static compile(dslJson: string): DslAst {
    let parsed: unknown;
    try {
      parsed = JSON.parse(dslJson);
    } catch (err) {
      throw new DslCompileError(
        `DSL JSON parse error: ${(err as Error).message}`,
      );
    }

    if (!parsed || typeof parsed !== 'object') {
      throw new DslCompileError('DSL root must be a JSON object');
    }

    const obj = parsed as Record<string, unknown>;

    // version 字段可选，默认为 "1"
    const version = typeof obj.version === 'string' ? obj.version : '1';

    // rules 字段必须存在且为非空数组
    if (!Array.isArray(obj.rules)) {
      throw new DslCompileError('DSL: "rules" field is required and must be an array');
    }

    const rules: PolicyRule[] = [];
    for (let i = 0; i < obj.rules.length; i++) {
      const raw = obj.rules[i];
      const rule = this.parseRule(raw, i);
      rules.push(rule);
    }

    return { version, rules };
  }

  /**
   * 校验已解析的 AST，检测规则冲突。
   * 返回冲突列表（可为空表示无冲突）。
   */
  static validate(ast: DslAst): string[] {
    const conflicts: string[] = [];
    const seenIds = new Set<string>();

    for (const rule of ast.rules) {
      // 重复 ID 检测
      if (seenIds.has(rule.id)) {
        conflicts.push(`duplicate rule id: ${rule.id}`);
      }
      seenIds.add(rule.id);

      // action 合法性
      if (!this.isValidAction(rule.action)) {
        conflicts.push(`invalid action pattern: "${rule.action}" in rule ${rule.id}`);
      }

      // resource 合法性
      if (!this.isValidResource(rule.resource)) {
        conflicts.push(`invalid resource pattern: "${rule.resource}" in rule ${rule.id}`);
      }
    }

    // 冲突对检测：同 action+resource 范围但 effect 相反的规则
    for (let i = 0; i < ast.rules.length; i++) {
      for (let j = i + 1; j < ast.rules.length; j++) {
        const a = ast.rules[i];
        const b = ast.rules[j];
        if (a.effect === b.effect) continue;
        if (this.actionsOverlap(a.action, b.action) && this.resourcesOverlap(a.resource, b.resource)) {
          conflicts.push(
            `conflicting rules: "${a.id}" (${a.effect}) vs "${b.id}" (${b.effect}) — same action/resource scope`,
          );
        }
      }
    }

    return conflicts;
  }

  // ── 内部解析器 ────────────────────────────────────────────────────

  private static parseRule(raw: unknown, index: number): PolicyRule {
    if (!raw || typeof raw !== 'object') {
      throw new DslCompileError(`DSL rule at index ${index} must be an object`);
    }

    const obj = raw as Record<string, unknown>;

    // id 必填
    if (typeof obj.id !== 'string' || !obj.id.trim()) {
      throw new DslCompileError(`DSL rule at index ${index} missing required "id" field`);
    }

    // effect 必填且只能是 allow | deny
    const effect = obj.effect;
    if (effect !== 'allow' && effect !== 'deny') {
      throw new DslCompileError(
        `DSL rule "${obj.id}" invalid effect: "${effect}" (expected "allow" or "deny")`,
      );
    }

    // action 必填
    if (typeof obj.action !== 'string' || !obj.action.trim()) {
      throw new DslCompileError(`DSL rule "${obj.id}" missing required "action" field`);
    }

    // resource 必填
    if (typeof obj.resource !== 'string' || !obj.resource.trim()) {
      throw new DslCompileError(`DSL rule "${obj.id}" missing required "resource" field`);
    }

    // condition 可选
    const condition = obj.condition && typeof obj.condition === 'object'
      ? obj.condition as Record<string, unknown>
      : undefined;

    return {
      id: obj.id.trim(),
      effect: effect as 'allow' | 'deny',
      action: obj.action.trim(),
      resource: obj.resource.trim(),
      condition,
    };
  }

  // ── 校验工具 ────────────────────────────────────────────────────────

  private static isValidAction(pattern: string): boolean {
    return pattern === '*' || /^[a-zA-Z0-9._-]+$/.test(pattern);
  }

  private static isValidResource(pattern: string): boolean {
    if (pattern === '*') return true;
    // 前缀模式：'prefix/*' 或 'prefix/sub/*'
    if (/^.*\/\*$/.test(pattern)) {
      const prefix = pattern.slice(0, -1); // 去掉尾部的 '*'
      return prefix.length > 0 && /^[a-zA-Z0-9._/-]+$/.test(prefix);
    }
    // 精确匹配
    return /^[a-zA-Z0-9._/-]+$/.test(pattern);
  }

  /**
   * 判断两个 action 模式是否可能重叠。
   * '*' 与任何 pattern 重叠；相同 pattern 重叠；不同精确 pattern 不重叠。
   */
  private static actionsOverlap(a: string, b: string): boolean {
    if (a === '*' || b === '*') return true;
    return a === b;
  }

  /**
   * 判断两个 resource 模式是否可能重叠。
   * 简单启发式：'*' 与任何重叠；同一前缀重叠；不同前缀不重叠。
   */
  private static resourcesOverlap(a: string, b: string): boolean {
    if (a === '*' || b === '*') return true;
    if (a === b) return true;
    // 同前缀检测：'repo/*' 和 'repo/prod/*' 重叠（'repo/' 是共同前缀）
    const aPrefix = a.replace(/\/\*$/, '');  // 去掉尾部的 '/*'
    const bPrefix = b.replace(/\/\*$/, '');  // 去掉尾部的 '/*'
    return (
      aPrefix.startsWith(bPrefix + '/') ||
      bPrefix.startsWith(aPrefix + '/')
    );
  }
}
