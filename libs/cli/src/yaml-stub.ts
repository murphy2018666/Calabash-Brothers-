/**
 * 简单 YAML 解析 stub（仅支持基础键值对）
 * 生产环境应替换为 js-yaml 或 yaml 库
 */

export interface YAML {
  parse(content: string): Record<string, unknown>;
}

export const YAML: YAML = {
  parse(content: string): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    const lines = content.split('\n');
    let currentKey: string | null = null;
    const arrayLines: string[] = [];

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;

      const match = trimmed.match(/^(\w+):\s*(.*)$/);
      if (match) {
        if (currentKey && arrayLines.length > 0) {
          result[currentKey] = arrayLines.map((l) => l.replace(/^- /, '').trim());
          arrayLines.length = 0;
        }
        currentKey = match[1];
        const value = match[2].trim();
        if (value === '') {
          arrayLines.length = 0;
        } else {
          result[currentKey] = value;
          currentKey = null;
        }
      } else if (currentKey && trimmed.startsWith('- ')) {
        arrayLines.push(trimmed);
      }
    }

    if (currentKey && arrayLines.length > 0) {
      result[currentKey] = arrayLines.map((l) => l.replace(/^- /, '').trim());
    }

    return result;
  },
};
