import { describe, it, expect, vi, beforeEach } from 'vitest';
import axios from 'axios';
import * as market from '@/api/market';

vi.mock('axios');
const mockedAxios = vi.mocked(axios);

const mockAxiosInstance = {
  get: vi.fn(),
  post: vi.fn(),
};

beforeEach(() => {
  vi.resetAllMocks();
  mockedAxios.create.mockReturnValue(mockAxiosInstance as any);
});

describe('market API', () => {
  it('fetches skill list with pagination params', async () => {
    mockAxiosInstance.get.mockResolvedValue({ data: { skills: [], total: 0, page: 1 } });

    await market.fetchSkills(2, 10, { state: 'active' });

    expect(mockAxiosInstance.get).toHaveBeenCalledWith(expect.stringContaining('page=2'));
    expect(mockAxiosInstance.get).toHaveBeenCalledWith(expect.stringContaining('pageSize=10'));
    expect(mockAxiosInstance.get).toHaveBeenCalledWith(expect.stringContaining('state=active'));
  });

  it('searches skills by keyword', async () => {
    mockAxiosInstance.get.mockResolvedValue({ data: { skills: [], total: 0 } });

    await market.searchSkills('auth', 1, 20);

    expect(mockAxiosInstance.get).toHaveBeenCalledWith(expect.stringContaining('q=auth'));
  });

  it('installs a skill and returns task', async () => {
    const task = { taskId: 't1', skillId: 's1', status: 'pending', progress: 0 };
    mockAxiosInstance.post.mockResolvedValue({ data: task });

    const result = await market.installSkill('s1', 'tenant-1', 'admin');

    expect(result.taskId).toBe('t1');
    expect(mockAxiosInstance.post).toHaveBeenCalledWith('/skills/s1/install', { tenantId: 'tenant-1', approvedBy: 'admin' });
  });

  it('verifies signature chain', async () => {
    const sigResult = { cosign: { ok: true }, certificate: { ok: true }, rekor: { ok: true }, compliance: { ok: true }, overall: 'passed' as const };
    mockAxiosInstance.post.mockResolvedValue({ data: sigResult });

    const result = await market.verifySignature('s1');

    expect(result.overall).toBe('passed');
    expect(mockAxiosInstance.post).toHaveBeenCalledWith('/skills/verify-signature', { skillId: 's1' });
  });

  it('fetches categories', async () => {
    mockAxiosInstance.get.mockResolvedValue({ data: [{ type: 'tool', count: 3 }] });

    const result = await market.fetchCategories();

    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool');
  });

  it('gets install task status', async () => {
    const task = { taskId: 't1', status: 'completed', progress: 100 };
    mockAxiosInstance.get.mockResolvedValue({ data: task });

    const result = await market.getInstallStatus('t1');

    expect(result!.status).toBe('completed');
    expect(mockAxiosInstance.get).toHaveBeenCalledWith('/skills/tasks/t1');
  });
});
