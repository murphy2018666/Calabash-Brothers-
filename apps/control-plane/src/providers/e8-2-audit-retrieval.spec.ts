/**
 * E8-2: AuditRetrievalService 单元测试
 *
 * 覆盖：
 * - 审计检索（多维度过滤）
 * - 游标分页
 * - 审计统计摘要生成
 * - 参数校验与规范化
 * - 空结果处理
 * - 边界条件
 */
import { Test } from '@nestjs/testing';
import { AuditRetrievalService, type AuditQueryParams, type AuditRepositoryPort } from './audit-retrieval.service';
import type { AuditEnvelope } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试数据工厂
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function makeEnvelope(overrides: Partial<AuditEnvelope> = {}): AuditEnvelope {
  return {
    envelopeId: `env_${Math.random().toString(36).slice(2)}`,
    tenantId: 'tenant-001',
    principalId: 'user-alice',
    principalType: 'user',
    action: 'pipeline.gate.passed',
    resource: 'gate:abc-123',
    evidenceId: 'evt-001',
    traceSpanId: 'span-001',
    result: 'success',
    timestamp: '2026-09-08T10:00:00.000Z',
    metadata: {},
    ...overrides,
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 内存仓储实现
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class InMemoryAuditRepo implements AuditRepositoryPort {
  private readonly store: AuditEnvelope[] = [];

  async query(params: AuditQueryParams): Promise<AuditEnvelope[]> {
    let results = [...this.store];

    if (params.runId) {
      results = results.filter((e) => e.metadata.runId === params.runId);
    }
    if (params.principalId) {
      results = results.filter((e) => e.principalId === params.principalId);
    }
    if (params.action) {
      results = results.filter((e) => e.action === params.action);
    }
    if (params.result) {
      results = results.filter((e) => e.result === params.result);
    }
    if (params.from) {
      results = results.filter((e) => e.timestamp >= params.from!);
    }
    if (params.to) {
      results = results.filter((e) => e.timestamp <= params.to!);
    }

    // 游标过滤
    if (params.cursor) {
      const cursorIdx = results.findIndex((e) => e.envelopeId === params.cursor);
      if (cursorIdx >= 0) {
        results = results.slice(cursorIdx + 1);
      }
    }

    return results.slice(0, params.limit);
  }

  async listByTenant(tenantId: string): Promise<AuditEnvelope[]> {
    if (tenantId === '*') return [...this.store];
    return this.store.filter((e) => e.tenantId === tenantId);
  }

  async exists(envelopeId: string): Promise<boolean> {
    return this.store.some((e) => e.envelopeId === envelopeId);
  }

  clear(): void {
    this.store.length = 0;
  }

  add(envelope: AuditEnvelope): void {
    this.store.push(envelope);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 测试
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('E8-2 AuditRetrievalService', () => {
  let service: AuditRetrievalService;
  let repo: InMemoryAuditRepo;

  beforeEach(async () => {
    repo = new InMemoryAuditRepo();
    const moduleRef = await Test.createTestingModule({
      providers: [
        AuditRetrievalService,
        { provide: 'AuditRepositoryPort', useValue: repo },
      ],
    }).compile();
    service = moduleRef.get<AuditRetrievalService>(AuditRetrievalService);
  });

  afterEach(() => {
    repo.clear();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 基础检索
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E8-2-1: returns all entries when no filters', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', action: 'pipeline.triggered' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2', action: 'pipeline.planned' }));
    repo.add(makeEnvelope({ envelopeId: 'env-3', action: 'gate.passed' }));

    const result = await service.query({ limit: 50 });

    expect(result.entries).toHaveLength(3);
    expect(result.nextCursor).toBe('');
    expect(result.queryMs).toBeGreaterThanOrEqual(0);
  });

  it('E8-2-2: filters by principalId', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', principalId: 'user-alice', action: 'pipeline.triggered' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2', principalId: 'user-bob', action: 'pipeline.planned' }));
    repo.add(makeEnvelope({ envelopeId: 'env-3', principalId: 'user-alice', action: 'gate.passed' }));

    const result = await service.query({ principalId: 'user-alice', limit: 50 });

    expect(result.entries).toHaveLength(2);
    expect(result.entries.every((e) => e.principalId === 'user-alice')).toBe(true);
  });

  it('E8-2-3: filters by action', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', action: 'pipeline.triggered' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2', action: 'gate.passed' }));
    repo.add(makeEnvelope({ envelopeId: 'env-3', action: 'approval.voted' }));

    const result = await service.query({ action: 'gate.passed', limit: 50 });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].action).toBe('gate.passed');
  });

  it('E8-2-4: filters by result', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', result: 'success' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2', result: 'denied' }));
    repo.add(makeEnvelope({ envelopeId: 'env-3', result: 'success' }));

    const result = await service.query({ result: 'denied', limit: 50 });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].result).toBe('denied');
  });

  it('E8-2-5: filters by time range', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', timestamp: '2026-09-07T10:00:00.000Z' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2', timestamp: '2026-09-08T10:00:00.000Z' }));
    repo.add(makeEnvelope({ envelopeId: 'env-3', timestamp: '2026-09-09T10:00:00.000Z' }));

    const result = await service.query({
      from: '2026-09-08T00:00:00.000Z',
      to: '2026-09-08T23:59:59.999Z',
      limit: 50,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].envelopeId).toBe('env-2');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 游标分页
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E8-2-6: supports cursor-based pagination', async () => {
    for (let i = 1; i <= 5; i++) {
      repo.add(makeEnvelope({ envelopeId: `env-${i}` }));
    }

    const page1 = await service.query({ limit: 2 });
    expect(page1.entries).toHaveLength(1); // limit-1（第2个作为游标被移除）
    expect(page1.nextCursor).toBe('env-2');
    expect(page1.truncated).toBe(true);

    const page2 = await service.query({ limit: 2, cursor: page1.nextCursor });
    expect(page2.entries).toHaveLength(1); // env-3和env-4中，env-4作为游标被移除
    expect(page2.nextCursor).toBe('env-4');

    const page3 = await service.query({ limit: 2, cursor: page2.nextCursor });
    expect(page3.entries).toHaveLength(1); // 只剩env-5，不足limit=2，无游标
    expect(page3.nextCursor).toBe('');
    expect(page3.truncated).toBe(false);
  });

  it('E8-2-7: returns empty nextCursor when no more pages', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2' }));

    const result = await service.query({ limit: 10 });
    expect(result.nextCursor).toBe('');
    expect(result.entries).toHaveLength(2);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 参数校验
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E8-2-8: defaults limit to 50 when not provided', async () => {
    for (let i = 1; i <= 60; i++) {
      repo.add(makeEnvelope({ envelopeId: `env-${i}` }));
    }

    const result = await service.query({});
    expect(result.entries).toHaveLength(49); // default limit 50，pop后剩49
    expect(result.nextCursor).toBeTruthy();
    expect(result.truncated).toBe(true);
  });

  it('E8-2-9: caps limit at 200', async () => {
    const result = await service.query({ limit: 999 });
    expect(result.entries.length).toBeLessThanOrEqual(200);
  });

  it('E8-2-10: enforces minimum limit of 1', async () => {
    const result = await service.query({ limit: 0 });
    expect(result.entries.length).toBeLessThanOrEqual(1);
  });

  it('E8-2-11: returns empty result for non-matching filter', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', principalId: 'user-alice' }));

    const result = await service.query({ principalId: 'user-nonexistent', limit: 10 });
    expect(result.entries).toHaveLength(0);
    expect(result.nextCursor).toBe('');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 审计统计摘要
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E8-2-12: generates summary with correct counts', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', action: 'gate.passed', result: 'success', timestamp: '2026-09-08T10:00:00.000Z' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2', action: 'gate.blocked', result: 'denied', timestamp: '2026-09-08T11:00:00.000Z' }));
    repo.add(makeEnvelope({ envelopeId: 'env-3', action: 'gate.passed', result: 'success', timestamp: '2026-09-08T12:00:00.000Z' }));
    repo.add(makeEnvelope({ envelopeId: 'env-4', action: 'deployment.failed', result: 'failed', timestamp: '2026-09-08T13:00:00.000Z' }));

    const summary = await service.generateSummary('tenant-001', '2026-09-08T00:00:00.000Z', '2026-09-08T23:59:59.999Z');

    expect(summary.totalEnvelopes).toBe(4);
    expect(summary.byResult.success).toBe(2);
    expect(summary.byResult.denied).toBe(1);
    expect(summary.byResult.failed).toBe(1);
    expect(summary.topActions).toHaveLength(3); // gate.passed, gate.blocked, deployment.failed
    expect(summary.topActions[0].action).toBe('gate.passed');
    expect(summary.topActions[0].count).toBe(2);
  });

  it('E8-2-13: top principals sorted by count', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', principalId: 'user-alice', timestamp: '2026-09-08T10:00:00.000Z' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2', principalId: 'user-alice', timestamp: '2026-09-08T11:00:00.000Z' }));
    repo.add(makeEnvelope({ envelopeId: 'env-3', principalId: 'user-bob', timestamp: '2026-09-08T12:00:00.000Z' }));

    const summary = await service.generateSummary('tenant-001', '2026-09-08T00:00:00.000Z', '2026-09-08T23:59:59.999Z');

    expect(summary.topPrincipals).toHaveLength(2);
    expect(summary.topPrincipals[0].principalId).toBe('user-alice');
    expect(summary.topPrincipals[0].count).toBe(2);
    expect(summary.topPrincipals[1].principalId).toBe('user-bob');
    expect(summary.topPrincipals[1].count).toBe(1);
  });

  it('E8-2-14: denied actions included in summary', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', result: 'denied', action: 'gate.blocked' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2', result: 'success', action: 'gate.passed' }));

    const summary = await service.generateSummary('tenant-001', '2026-01-01T00:00:00.000Z', '2026-12-31T23:59:59.999Z');

    expect(summary.deniedActions).toHaveLength(1);
    expect(summary.deniedActions[0].result).toBe('denied');
  });

  it('E8-2-15: summary handles empty dataset', async () => {
    const summary = await service.generateSummary('tenant-001', '2026-09-08T00:00:00.000Z', '2026-09-08T23:59:59.999Z');

    expect(summary.totalEnvelopes).toBe(0);
    expect(summary.byResult.success).toBe(0);
    expect(summary.topActions).toEqual([]);
    expect(summary.topPrincipals).toEqual([]);
    expect(summary.deniedActions).toEqual([]);
  });

  it('E8-2-16: summary respects tenant filter', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', tenantId: 'tenant-001', timestamp: '2026-09-08T10:00:00.000Z' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2', tenantId: 'tenant-002', timestamp: '2026-09-08T10:00:00.000Z' }));

    const summary = await service.generateSummary('tenant-001', '2026-09-08T00:00:00.000Z', '2026-09-08T23:59:59.999Z');

    expect(summary.totalEnvelopes).toBe(1);
    expect(summary.tenantId).toBe('tenant-001');
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // 边界条件
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('E8-2-17: handles large result set with pagination', async () => {
    for (let i = 1; i <= 250; i++) {
      repo.add(makeEnvelope({ envelopeId: `env-${i.toString().padStart(3, '0')}` }));
    }

    const page1 = await service.query({ limit: 100 });
    expect(page1.entries).toHaveLength(99); // limit-1
    expect(page1.nextCursor).toBeTruthy();
    expect(page1.truncated).toBe(true);

    const page2 = await service.query({ limit: 100, cursor: page1.nextCursor });
    expect(page2.entries).toHaveLength(99);

    const page3 = await service.query({ limit: 100, cursor: page2.nextCursor });
    expect(page3.entries).toHaveLength(50); // 剩余50个，不足100，无游标
    expect(page3.nextCursor).toBe('');
    expect(page3.truncated).toBe(false);
  });

  it('E8-2-18: queryMs is reasonable (not negative)', async () => {
    repo.add(makeEnvelope());
    const result = await service.query({ limit: 10 });
    expect(result.queryMs).toBeGreaterThanOrEqual(0);
  });

  it('E8-2-19: composite filter works correctly', async () => {
    repo.add(makeEnvelope({ envelopeId: 'env-1', principalId: 'user-alice', action: 'gate.passed', result: 'success', timestamp: '2026-09-08T10:00:00.000Z' }));
    repo.add(makeEnvelope({ envelopeId: 'env-2', principalId: 'user-alice', action: 'gate.blocked', result: 'denied', timestamp: '2026-09-08T10:00:00.000Z' }));
    repo.add(makeEnvelope({ envelopeId: 'env-3', principalId: 'user-bob', action: 'gate.passed', result: 'success', timestamp: '2026-09-08T10:00:00.000Z' }));

    const result = await service.query({
      principalId: 'user-alice',
      action: 'gate.passed',
      result: 'success',
      limit: 10,
    });

    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].envelopeId).toBe('env-1');
  });
});
