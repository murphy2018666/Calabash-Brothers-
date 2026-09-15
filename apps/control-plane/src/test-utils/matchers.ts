/**
 * 自定义 Jest 匹配器（增强断言能力）
 */

declare global {
  namespace jest {
    interface Matchers<R> {
      /** 验证对象包含指定属性 */
      toHaveProperties(...properties: string[]): R;
      /** 验证数组长度在范围内 */
      toHaveLengthBetween(min: number, max: number): R;
      /** 验证值是有效 ISO 日期字符串 */
      toBeValidISODate(): R;
      /** 验证对象具有特定结构 */
      toMatchStructure(structure: Record<string, unknown>): R;
    }
  }
}

export {};

/**
 * 实现自定义匹配器
 */
expect.extend({
  toHaveProperties(actual: Record<string, unknown>, ...properties: string[]) {
    const missing = properties.filter((p) => !(p in actual));
    if (missing.length === 0) {
      return {
        pass: true,
        message: () => `expected object not to have properties ${missing.join(', ')}`,
      };
    }
    return {
      pass: false,
      message: () =>
        `expected object to have properties ${missing.join(', ')}, but got ${Object.keys(actual).join(', ')}`,
    };
  },

  toHaveLengthBetween(actual: unknown[], min: number, max: number) {
    const pass = actual.length >= min && actual.length <= max;
    return {
      pass,
      message: () =>
        `expected array length to be between ${min} and ${max}, but got ${actual.length}`,
    };
  },

  toBeValidISODate(actual: unknown) {
    if (typeof actual !== 'string') {
      return { pass: false, message: () => `expected ${actual} to be a string` };
    }
    const date = new Date(actual);
    const valid = !isNaN(date.getTime()) && /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?/.test(actual);
    return {
      pass: valid,
      message: () => `expected ${actual} to be a valid ISO date string`,
    };
  },

  toMatchStructure(actual: Record<string, unknown>, structure: Record<string, unknown>) {
    const missing = Object.keys(structure).filter((k) => !(k in actual));
    const pass = missing.length === 0;
    return {
      pass,
      message: () =>
        `expected object to match structure ${JSON.stringify(structure)}, but missing keys: ${missing.join(', ')}`,
    };
  },
});
