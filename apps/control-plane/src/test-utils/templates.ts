/**
 * 测试模板库（S28+）
 *
 * 包含：
 * 1. service.spec.ts 模板 — CRUD 服务标准测试结构
 * 2. controller.spec.ts 模板 — NestJS 控制器标准测试结构
 * 3. e2e.spec.ts 模板 — 端到端集成测试标准结构
 * 4. test-helpers.ts — 通用测试工具函数
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 1. Service Spec 模板
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * CRUD 服务测试模板（适用于有 create/query/update/delete 方法的服务）
 *
 * 使用方法：
 * 1. 替换 {ServiceName} 为实际服务名
 * 2. 替换 {ServiceClass} 为实际导入类
 * 3. 根据业务逻辑调整测试用例
 */

export const SERVICE_SPEC_TEMPLATE = `
import { {ServiceClass} } from './{service-name}.service';

describe('{ServiceName} ({KR})', () => {
  let service: {ServiceClass};

  beforeEach(() => {
    service = new {ServiceClass}();
  });

  afterEach(() => {
    service.clear?.();
  });

  // ── 创建 ──

  it('create: 正常路径', () => {
    const result = service.create(/* 参数 */);
    expect(result).toBeDefined();
  });

  it('create: 生成唯一 ID', () => {
    const r1 = service.create(/* 参数 */);
    const r2 = service.create(/* 参数 */);
    expect(r1.id).not.toBe(r2.id);
  });

  it('create: 空值校验', () => {
    expect(() => service.create(/* 空参数 */)).toThrow();
  });

  it('create: 重复创建冲突', () => {
    service.create(/* 参数 1 */);
    expect(() => service.create(/* 参数 2 重复 */)).toThrow();
  });

  // ── 查询 ──

  it('query: 返回匹配结果', () => {
    service.create(/* 参数 */);
    const result = service.query(/* 条件 */);
    expect(result).toBeDefined();
  });

  it('query: 不存在返回 null/undefined', () => {
    const result = service.query('non-existent-id');
    expect(result).toBeNull();
  });

  it('query: 租户隔离', () => {
    service.createForTenant('t-a', /* 参数 */);
    service.createForTenant('t-b', /* 参数 */);
    expect(service.queryForTenant('t-a').length).toBe(1);
    expect(service.queryForTenant('t-b').length).toBe(1);
  });

  // ── 更新 ──

  it('update: 部分更新', () => {
    const item = service.create(/* 参数 */);
    const updated = service.update(item.id, { field: 'new-value' });
    expect(updated.field).toBe('new-value');
  });

  it('update: 不存在返回 null', () => {
    const result = service.update('fake-id', { field: 'value' });
    expect(result).toBeNull();
  });

  it('update: 校验规则', () => {
    const item = service.create(/* 参数 */);
    expect(() => service.update(item.id, { invalidField: -1 })).toThrow();
  });

  // ── 删除 ──

  it('delete: 正常删除', () => {
    const item = service.create(/* 参数 */);
    const result = service.delete(item.id);
    expect(result).toBe(true);
    expect(service.query(item.id)).toBeNull();
  });

  it('delete: 不存在返回 false', () => {
    const result = service.delete('fake-id');
    expect(result).toBe(false);
  });

  it('delete: 权限校验', () => {
    const item = service.createForTenant('t-owner', /* 参数 */);
    expect(service.deleteForTenant(item.id, 't-other')).toBe(false);
  });

  // ── 列表查询 ──

  it('list: 返回租户所有记录', () => {
    service.createForTenant('t-list', /* 参数 1 */);
    service.createForTenant('t-list', /* 参数 2 */);
    expect(service.list('t-list').length).toBe(2);
  });

  it('list: 租户隔离', () => {
    service.createForTenant('t-a', /* 参数 */);
    service.createForTenant('t-b', /* 参数 */);
    expect(service.list('t-a').length).toBe(1);
    expect(service.list('t-b').length).toBe(1);
  });
});
`;

/**
 * 事件驱动服务测试模板（适用于发布领域事件的服务）
 */
export const EVENT_DRIVER_SPEC_TEMPLATE = `
import { {ServiceClass} } from './{service-name}.service';
import { EventEmitter2 } from '@nestjs/event-emitter';

describe('{ServiceName} (Event Driver)', () => {
  let service: {ServiceClass};
  let eventEmitter: EventEmitter2;
  let emittedEvents: unknown[];

  beforeEach(() => {
    emittedEvents = [];
    eventEmitter = {
      emit: jest.fn((event: string, payload: unknown) => {
        emittedEvents.push({ event, payload });
      }),
    } as any;
    service = new {ServiceClass}(eventEmitter as any);
  });

  afterEach(() => {
    service.clear?.();
  });

  it('emits event on create', () => {
    service.create(/* 参数 */);
    expect(eventEmitter.emit).toHaveBeenCalled();
    expect(emittedEvents.some(e => e.event === '{event.type}')).toBe(true);
  });

  it('emits event on delete', () => {
    const item = service.create(/* 参数 */);
    service.delete(item.id);
    expect(emittedEvents.some(e => e.event === '{delete.event.type}')).toBe(true);
  });

  it('handles event emission failure gracefully', () => {
    (eventEmitter.emit as jest.Mock).mockImplementation(() => {
      throw new Error('Emitter failed');
    });
    // 不应抛出异常
    expect(() => service.create(/* 参数 */)).not.toThrow();
  });
});
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 2. Controller Spec 模板
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * REST 控制器测试模板
 */
export const CONTROLLER_SPEC_TEMPLATE = `
import { Test, TestingModule } from '@nestjs/testing';
import { {ControllerClass} } from './{controller-name}.controller';
import { {ServiceClass} } from '../services/{service-name}.service';

describe('{ControllerName}', () => {
  let controller: {ControllerClass};
  let service: {ServiceClass};

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [{ControllerClass}],
      providers: [{ServiceClass}],
    }).compile();

    controller = module.get<{ControllerClass}>({ControllerClass});
    service = module.get<{ServiceClass}>({ServiceClass});
  });

  it('POST /api/{resource}: creates resource', () => {
    const result = controller.create({ /* body */ });
    expect(result).toBeDefined();
  });

  it('GET /api/{resource}/{id}: returns resource', () => {
    const result = controller.findOne('test-id');
    expect(result).toBeDefined();
  });

  it('GET /api/{resource}: returns list', () => {
    const result = controller.findAll();
    expect(Array.isArray(result)).toBe(true);
  });

  it('PUT /api/{resource}/{id}: updates resource', () => {
    const result = controller.update('test-id', { /* updates */ });
    expect(result).toBeDefined();
  });

  it('DELETE /api/{resource}/{id}: deletes resource', () => {
    const result = controller.remove('test-id');
    expect(result).toBe(true);
  });
});
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 3. E2E Spec 模板
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * E2E 集成测试模板
 */
export const E2E_SPEC_TEMPLATE = `
import { {ServiceClass1} } from '../services/{service1}';
import { {ServiceClass2} } from '../services/{service2}';
import { {ServiceClass3} } from '../services/{service3}';

describe('{E2E-Name} ({Sprint})', () => {
  let service1: {ServiceClass1};
  let service2: {ServiceClass2};
  let service3: {ServiceClass3};

  beforeEach(() => {
    service1 = new {ServiceClass1}();
    service2 = new {ServiceClass2}();
    service3 = new {ServiceClass3}();
  });

  afterEach(() => {
    service1.clear?.();
    service2.clear?.();
    service3.clear?.();
  });

  // ── 场景 1：正常流程 ──

  it('E2E-1: 主流程完整', () => {
    // 1. 前置条件
    const resource = service1.create(/* 参数 */);
    expect(resource).toBeDefined();

    // 2. 执行操作
    const result = service2.process(resource.id);
    expect(result).toBeDefined();

    // 3. 验证后置状态
    const updated = service1.findOne(resource.id);
    expect(updated.status).toBe('processed');
  });

  // ── 场景 2：边界条件 ──

  it('E2E-2: 配额耗尽后触发计费', () => {
    const quota = 10;
    let callsUsed = 0;

    // 配额内免费
    for (let i = 0; i < quota; i++) {
      const cost = service2.calcCost('t', 'skill', 'freemium', 5, quota, callsUsed);
      expect(cost).toBe(0);
      callsUsed++;
    }

    // 超配额后计费
    const overageCost = service2.calcCost('t', 'skill', 'freemium', 5, quota, callsUsed);
    expect(overageCost).toBeGreaterThan(0);
  });

  // ── 场景 3：权限隔离 ──

  it('E2E-3: 租户间数据隔离', () => {
    service1.createForTenant('t-a', /* 参数 */);
    service1.createForTenant('t-b', /* 参数 */);

    const aRecords = service1.list('t-a');
    const bRecords = service1.list('t-b');

    expect(aRecords.length).toBe(1);
    expect(bRecords.length).toBe(1);
    expect(aRecords[0].id).not.toBe(bRecords[0].id);
  });

  // ── 场景 4：数据一致性 ──

  it('E2E-4: 计量数据与统计一致', () => {
    service1.recordUsage('call', 't-consistent', 'skill-c', { cost: 10 });
    service1.recordUsage('call', 't-consistent', 'skill-c', { cost: 20 });

    const records = service1.queryUsage('t-consistent');
    const stats = service1.getStats('t-consistent');

    expect(records.length).toBe(2);
    expect(stats.totalCalls).toBe(2);
    expect(stats.totalCost).toBe(30);
  });

  // ── 场景 5：性能基准 ──

  it('E2E-5: 写入性能 < 10ms P95', () => {
    const iterations = 100;
    const times: number[] = [];

    for (let i = 0; i < iterations; i++) {
      const start = Date.now();
      service1.recordUsage('call', 't-perf', 'skill-p', {});
      times.push(Date.now() - start);
    }

    times.sort((a, b) => a - b);
    const p95 = times[Math.floor(iterations * 0.95)];
    expect(p95).toBeLessThan(10);
  });

  // ── 场景 6：跨服务集成 ──

  it('E2E-6: 定价 + 计量 + 独占包 联动', () => {
    // 1. 创建独占包并发布并授权
    const pack = service3.createExclusivePack('t-owner', 'linked-pack', ['pol-1']);
    service3.publishPack(pack.packId);
    service3.grantAccess(pack.packId, 't-grantee');

    // 2. 为授权租户创建定价
    service1.createPricingPlan('skill-tool', 't-grantee', 'monthly', 49.99);

    // 3. 记录计量
    service2.recordUsage('call', 't-grantee', 'skill-tool', { cost: 5 });

    // 4. 验证所有服务数据一致
    const packs = service3.getAvailablePacks('t-grantee');
    const stats = service2.getStats('t-grantee');
    const plan = service1.getPricingPlan('skill-tool', 't-grantee');

    expect(packs.length).toBeGreaterThan(0);
    expect(stats.totalCalls).toBe(1);
    expect(plan).toBeDefined();
  });
});
`;

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 4. Test Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

/**
 * 通用测试工具函数
 */

/**
 * 生成唯一 ID
 */
export function generateId(prefix: string = 'id'): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * 生成测试用租户 ID
 */
export function generateTenantId(suffix: string = ''): string {
  return `t-${suffix || Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 生成测试用技能 ID
 */
export function generateSkillId(suffix: string = ''): string {
  return `skill-${suffix || Math.random().toString(36).slice(2, 6)}`;
}

/**
 * 等待指定时间（用于异步测试）
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 计算 P95 值
 */
export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, index)];
}

/**
 * 模拟 EventEmitter2（用于测试事件发布）
 */
export function createMockEventEmitter() {
  const emitted: Array<{ event: string; payload: unknown }> = [];
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  return {
    emit: jest.fn((event: string, payload: unknown) => {
      emitted.push({ event, payload });
      listeners.get(event)?.forEach((fn) => fn(payload));
    }),
    on: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event)!.push(listener);
    }),
    off: jest.fn((event: string, listener: (...args: unknown[]) => void) => {
      const lsn = listeners.get(event);
      if (lsn) {
        const idx = lsn.indexOf(listener);
        if (idx >= 0) lsn.splice(idx, 1);
      }
    }),
    reset: () => {
      emitted.length = 0;
      listeners.clear();
    },
    getEmitted: () => emitted,
  };
}

/**
 * 创建带 clear() 方法的 jest mock（用于服务清理）
 */
export function createMockServiceWithClear<T extends Record<string, any>>(base: T): T & { clear: () => void } {
  return {
    ...base,
    clear: jest.fn(),
  } as any;
}

/**
 * 批量创建测试数据
 */
export function batchCreate<T>(
  createFn: (index: number) => T,
  count: number,
): T[] {
  return Array.from({ length: count }, (_, i) => createFn(i));
}

/**
 * 验证租户隔离（通用）
 */
export function assertTenantIsolation<T>(
  createFn: (tenantId: string, ...args: any[]) => T,
  queryFn: (tenantId: string) => T[],
  tenantA: string = 't-a',
  tenantB: string = 't-b',
) {
  const itemA = createFn(tenantA, /* 参数 */);
  const itemB = createFn(tenantB, /* 参数 */);

  const resultsA = queryFn(tenantA);
  const resultsB = queryFn(tenantB);

  expect(resultsA).toHaveLength(1);
  expect(resultsB).toHaveLength(1);
  expect(resultsA[0].id).not.toBe(resultsB[0].id);
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 导出（供 IDE 索引和文档生成使用）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export const TestTemplates = {
  service: SERVICE_SPEC_TEMPLATE,
  controller: CONTROLLER_SPEC_TEMPLATE,
  e2e: E2E_SPEC_TEMPLATE,
  eventDriver: EVENT_DRIVER_SPEC_TEMPLATE,
};

export const TestHelpers = {
  generateId,
  generateTenantId,
  generateSkillId,
  delay,
  percentile,
  createMockEventEmitter,
  createMockServiceWithClear,
  batchCreate,
  assertTenantIsolation,
};
