/**
 * 测试 fixtures（常用测试数据）
 */

/**
 * 创建测试用租户 ID
 */
export function testTenant(suffix: string = ''): string {
  return `t-${suffix || Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 创建测试用技能 ID
 */
export function testSkill(suffix: string = ''): string {
  return `skill-${suffix || Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 创建测试用计划 ID
 */
export function testPlanId(): string {
  return `plan-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建测试用包 ID
 */
export function testPackId(): string {
  return `pack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 创建测试用事件 ID
 */
export function testEventId(): string {
  return `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 常见测试数据
 */
export const TEST_DATA = {
  tenants: {
    small: testTenant('small'),
    medium: testTenant('medium'),
    large: testTenant('large'),
  },
  skills: {
    tool: testSkill('tool'),
    agent: testSkill('agent'),
    connector: testSkill('connector'),
  },
  pricing: {
    monthly: { period: 'monthly' as const, price: 99.99 },
    yearly: { period: 'yearly' as const, price: 999.99 },
    perpetual: { period: 'perpetual' as const, price: 499.99 },
  },
  events: {
    call: 'call',
    agent: 'agent',
    connector: 'connector',
  },
};

/**
 * 创建默认测试参数
 */
export function defaultCreateParams(tenantId?: string, skillId?: string) {
  return {
    tenantId: tenantId || testTenant(),
    skillId: skillId || testSkill(),
  };
}
