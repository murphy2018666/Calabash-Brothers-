import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { useSkillStore } from '@/stores/useSkillStore';
import * as marketApi from '@/api/market';

vi.mock('@/api/market', () => ({
  fetchSkills: vi.fn(),
  searchSkills: vi.fn(),
  fetchSkillDetail: vi.fn(),
  installSkill: vi.fn(),
  getInstallStatus: vi.fn(),
  fetchCategories: vi.fn(),
}));

const mockFetchSkills = vi.mocked(marketApi.fetchSkills);
const mockSearchSkills = vi.mocked(marketApi.searchSkills);
const mockFetchSkillDetail = vi.mocked(marketApi.fetchSkillDetail);
const mockInstallSkill = vi.mocked(marketApi.installSkill);
const mockGetInstallStatus = vi.mocked(marketApi.getInstallStatus);
const mockFetchCategories = vi.mocked(marketApi.fetchCategories);

describe('useSkillStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.resetAllMocks();
  });

  it('loads skills from API', async () => {
    mockFetchSkills.mockResolvedValue({
      skills: [{ skillId: 's1', name: 'Test Skill', version: '1.0.0', type: 'tool', description: 'desc', riskTier: 'G1', state: 'active', signatureVerified: true, tags: [], installedAt: '' }],
      total: 1,
      page: 1,
    });

    const store = useSkillStore();
    await store.loadSkills();

    expect(store.skills).toHaveLength(1);
    expect(store.total).toBe(1);
    expect(mockFetchSkills).toHaveBeenCalledWith(1, 20, undefined);
  });

  it('searches skills by keyword', async () => {
    mockSearchSkills.mockResolvedValue({ skills: [], total: 0 });

    const store = useSkillStore();
    await store.search('auth');

    expect(store.loading).toBe(false);
    expect(mockSearchSkills).toHaveBeenCalledWith('auth', 1, 20);
  });

  it('installs a skill and tracks task', async () => {
    const task = { taskId: 't1', skillId: 's1', status: 'pending', progress: 0 };
    mockInstallSkill.mockResolvedValue(task);

    const store = useSkillStore();
    const result = await store.installSkill('s1', 'tenant-1', 'admin');

    expect(result.taskId).toBe('t1');
    expect(store.getTask('t1')).toEqual(task);
  });

  it('polls install status and updates stored task', async () => {
    const task = { taskId: 't1', skillId: 's1', status: 'completed', progress: 100 };
    mockGetInstallStatus.mockResolvedValue(task);

    const store = useSkillStore();
    const result = await store.pollInstallStatus('t1');

    expect(result!.status).toBe('completed');
    expect(store.getTask('t1')!.status).toBe('completed');
  });

  it('loads categories from API', async () => {
    mockFetchCategories.mockResolvedValue([{ type: 'tool', count: 5 }]);

    const store = useSkillStore();
    await store.loadCategories();

    expect(store.categories).toHaveLength(1);
    expect(store.categories[0].type).toBe('tool');
  });
});
