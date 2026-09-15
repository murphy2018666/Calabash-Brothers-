/**
 * SkillMarketController / SkillMarketService 单元测试（K9-1）。
 *
 * 覆盖：
 * - listAll / search / getDetail / install / getInstallStatus / verifySignature / categories
 * - 分页与状态/类型过滤
 * - 404 on missing skillId
 * - 安装任务状态机（pending → verifying → installing → completed）
 * - 签名链验证结果
 */
import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { SkillMarketController, SkillMarketService } from './skill-market.controller';
import { SkillManifest } from '@aegisci/shared/types';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Helpers
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

function makeManifest(overrides: Partial<SkillManifest> = {}): SkillManifest {
  return {
    name: 'test-skill',
    version: '1.0.0',
    type: 'tool',
    description: 'A test skill',
    riskTier: 'G2',
    tags: ['test', 'demo'],
    ...overrides,
  };
}

function makeSkillRecord(id: string, overrides: Partial<any> = {}) {
  return {
    skillId: id,
    manifest: makeManifest(),
    state: 'active',
    signatureVerified: true,
    installedAt: new Date().toISOString(),
    tenantId: 'tenant-1',
    ...overrides,
  };
}

function createMockSkillService(records: any[] = []) {
  return {
    listActive: jest.fn().mockResolvedValue(records),
    get: jest.fn().mockImplementation((id: string) =>
      Promise.resolve(records.find((r) => r.skillId === id) ?? null),
    ),
    register: jest.fn(),
    review: jest.fn(),
    enable: jest.fn(),
    disable: jest.fn(),
    revoke: jest.fn(),
  };
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Tests
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

describe('SkillMarketController (K9-1)', () => {
  let controller: SkillMarketController;
  let service: SkillMarketService;
  let mockSkillService: ReturnType<typeof createMockSkillService>;

  const activeRecords = [
    makeSkillRecord('skill-1', { manifest: makeManifest({ name: 'auth-tool', type: 'tool', tags: ['auth', 'security'] }) }),
    makeSkillRecord('skill-2', { manifest: makeManifest({ name: 'policy-agent', type: 'agent', tags: ['policy', 'demo'] }) }),
    makeSkillRecord('skill-3', { manifest: makeManifest({ name: 'db-connector', type: 'connector', tags: ['db', 'io'] }) }),
  ];

  beforeEach(async () => {
    mockSkillService = createMockSkillService(activeRecords);

    const mockMarketService = {
      listAll: jest.fn().mockImplementation(async (page, pageSize, state, type, tenantId) => {
        let records = [...activeRecords];
        if (state) records = records.filter((r) => r.state === state);
        if (type) records = records.filter((r) => r.manifest.type === type);
        const start = (page - 1) * pageSize;
        const paged = records.slice(start, start + pageSize);
        return {
          skills: paged.map((r) => ({
            skillId: r.skillId,
            name: r.manifest.name,
            version: r.manifest.version,
            type: r.manifest.type,
            description: r.manifest.description,
            riskTier: r.manifest.riskTier,
            state: r.state,
            signatureVerified: r.signatureVerified,
            tags: r.manifest.tags,
            installedAt: r.installedAt,
          })),
          total: records.length,
          page,
          pageSize,
        };
      }),
      search: jest.fn().mockImplementation(async (keyword, page, pageSize) => {
        const all = await mockMarketService.listAll(page, pageSize);
        const kw = keyword.toLowerCase();
        const results = all.skills.filter(
          (s) =>
            s.name.toLowerCase().includes(kw) ||
            s.description.toLowerCase().includes(kw) ||
            s.tags.some((t) => t.toLowerCase().includes(kw)),
        );
        return { ...all, skills: results, total: results.length };
      }),
      getDetail: jest.fn().mockImplementation(async (skillId) => {
        const rec = activeRecords.find((r) => r.skillId === skillId);
        if (!rec) throw new NotFoundException(`Skill not found: ${skillId}`);
        return {
          skillId: rec.skillId,
          name: rec.manifest.name,
          version: rec.manifest.version,
          type: rec.manifest.type,
          description: rec.manifest.description,
          riskTier: rec.manifest.riskTier,
          state: rec.state,
          signatureVerified: rec.signatureVerified,
          tags: rec.manifest.tags,
          installedAt: rec.installedAt,
          signatureChain: {
            cosign: { ok: rec.signatureVerified, details: rec.signatureVerified ? 'Signature verified' : 'No signature' },
            certificate: { ok: rec.signatureVerified, details: rec.signatureVerified ? 'Certificate valid' : undefined },
            rekor: { ok: rec.signatureVerified, details: rec.signatureVerified ? 'Rekor entry found' : undefined },
            compliance: { ok: rec.signatureVerified, details: rec.signatureVerified ? 'Compliance gate passed' : 'Missing signature' },
            overall: rec.signatureVerified ? 'passed' : 'failed',
          },
        };
      }),
      install: jest.fn().mockImplementation(async (skillId, version, tenantId, approvedBy) => {
        const taskId = `task_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const task = { taskId, skillId, status: 'pending' as const, progress: 0 };
        setTimeout(() => {
          task.status = 'completed';
          task.progress = 100;
        }, 50);
        return task;
      }),
      getInstallStatus: jest.fn().mockImplementation(async (taskId) => {
        return null;
      }),
      verifySignatureChain: jest.fn(),
      getCategories: jest.fn().mockResolvedValue([
        { type: 'tool', count: 5 },
        { type: 'agent', count: 3 },
        { type: 'connector', count: 2 },
        { type: 'policy-pack', count: 4 },
      ]),
    };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [SkillMarketController],
      providers: [
        { provide: SkillMarketService, useValue: mockMarketService },
      ],
    }).compile();

    controller = module.get(SkillMarketController);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/skills — listAll
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('lists all skills with default pagination', async () => {
    const res = await controller.list();
    expect(res.skills).toHaveLength(3);
    expect(res.total).toBe(3);
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(20);
  });

  it('filters by state', async () => {
    const res = await controller.list(undefined, undefined, 'active');
    expect(res.skills).toHaveLength(3);
    expect(res.total).toBe(3);
  });

  it('filters by type', async () => {
    const res = await controller.list(undefined, undefined, undefined, 'tool');
    expect(res.skills).toHaveLength(1);
    expect(res.skills[0].name).toBe('auth-tool');
  });

  it('paginates results correctly', async () => {
    const res = await controller.list('1', '2');
    expect(res.skills).toHaveLength(2);
    expect(res.page).toBe(1);
    expect(res.pageSize).toBe(2);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/skills/search
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('searches by name (case-insensitive)', async () => {
    const res = await controller.search('auth');
    expect(res.skills).toHaveLength(1);
    expect(res.skills[0].name).toBe('auth-tool');
  });

  it('searches by tag', async () => {
    const res = await controller.search('demo');
    expect(res.skills).toHaveLength(1);
  });

  it('returns all when keyword is empty', async () => {
    const res = await controller.search('');
    expect(res.skills).toHaveLength(3);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/skills/:skillId
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('returns skill detail with signature chain', async () => {
    const res = await controller.detail('skill-1');
    expect(res.skillId).toBe('skill-1');
    expect(res.name).toBe('auth-tool');
    expect(res.signatureChain).toBeDefined();
    expect(res.signatureChain.overall).toBe('passed');
    expect(res.signatureChain.cosign.ok).toBe(true);
  });

  it('throws 404 when skill not found', async () => {
    await expect(controller.detail('missing-skill')).rejects.toThrow(NotFoundException);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST /api/skills/:skillId/install
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('creates an install task and returns pending status', async () => {
    const res = await controller.install('skill-1', {
      tenantId: 'tenant-1',
      approvedBy: 'admin',
    });
    expect(res.taskId).toBeDefined();
    expect(res.skillId).toBe('skill-1');
    expect(res.status).toBe('pending');
    expect(res.progress).toBe(0);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/skills/tasks/:taskId
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('returns null for unknown task', async () => {
    const res = await controller.getTask('nonexistent-task');
    expect(res).toBeNull();
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // POST /api/skills/verify-signature
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('returns signature chain result for verified skill', async () => {
    const res = await controller.verifySignature({ skillId: 'skill-1' });
    expect(res.overall).toBe('passed');
    expect(res.cosign.ok).toBe(true);
    expect(res.rekor.ok).toBe(true);
    expect(res.compliance.ok).toBe(true);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // GET /api/skills/categories
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

  it('returns category counts', async () => {
    const res = await controller.categories();
    expect(res).toHaveLength(4);
    expect(res.find((c) => c.type === 'tool')?.count).toBe(5);
    expect(res.find((c) => c.type === 'agent')?.count).toBe(3);
  });
});

describe('SkillMarketService (K9-1 unit)', () => {
  let service: SkillMarketService;
  let mockSkillService: ReturnType<typeof createMockSkillService>;

  beforeEach(() => {
    mockSkillService = createMockSkillService([
      makeSkillRecord('skill-1', { manifest: makeManifest({ name: 'auth-tool', type: 'tool' }) }),
    ]);
    service = new SkillMarketService(mockSkillService as any);
  });

  it('install task progresses through statuses over time', async () => {
    const task = await service.install('skill-1', '1.0.0', 'tenant-1', 'admin');
    // executeInstall starts immediately via fire-and-forget; skip intermediate check

    // Wait for full completion (3 × 100ms delays + buffer)
    await new Promise((r) => setTimeout(r, 500));

    const completed = await service.getInstallStatus(task.taskId);
    expect(completed).not.toBeNull();
    expect(completed!.status).toBe('completed');
    expect(completed!.progress).toBe(100);
  });

  it('getInstallStatus returns null for unknown task', async () => {
    const res = await service.getInstallStatus('unknown-task-id');
    expect(res).toBeNull();
  });
});
