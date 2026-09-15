export interface CedarRule {
  ruleId: string;
  subject: string;
  action: string;
  resource: string;
  effect: 'Allow' | 'Deny' | 'Forbid';
  condition?: string;
  raw: string;
}

export interface CedarPolicySet {
  policySetId: string;
  version: string;
  rules: CedarRule[];
  compiledAt: string;
  [key: string]: unknown;
}

export interface FileParseResult {
  ok: boolean;
  errors: string[];
}

export interface ParseResult {
  ok: boolean;
  policySet: CedarPolicySet | null;
  errors?: string[];
}

/**
 * K7-2 · Cedar 策略语言解析器
 *
 * 负责将 Cedar DSL 文本解析为结构化的 CedarPolicySet。
 * 当前为 stub 实现：支持空文件列表快速返回，真实解析在后续迭代实现。
 */
export class CedarPolicyParserService {
  parse(_files: string[]): ParseResult {
    if (_files.length === 0) {
      return {
        ok: true,
        policySet: {
          policySetId: 'empty',
          version: '0.0.0',
          rules: [],
          compiledAt: new Date().toISOString(),
        },
      };
    }
    return {
      ok: false,
      policySet: null,
      errors: [`file not found: ${_files[0]}`],
    };
  }

  /**
   * 内部私有方法：解析单个 Cedar 文件内容
   * TODO: 实现真实 Cedar DSL 解析逻辑
   */
  private _parseFile(_content: string): FileParseResult {
    return { ok: true, errors: [] };
  }
}
