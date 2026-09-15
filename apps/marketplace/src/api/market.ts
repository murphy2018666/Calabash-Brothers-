import axios from 'axios';

const api = axios.create({
  baseURL: '/api',
  timeout: 10000,
});

export interface SkillListItem {
  skillId: string;
  name: string;
  version: string;
  type: string;
  description: string;
  riskTier: string;
  state: string;
  signatureVerified: boolean;
  tags: string[];
  installedAt: string;
}

export interface SignatureChainResult {
  cosign: { ok: boolean; details?: string };
  certificate: { ok: boolean; details?: string };
  rekor: { ok: boolean; details?: string };
  compliance: { ok: boolean; details?: string };
  overall: 'passed' | 'failed';
}

export interface InstallTask {
  taskId: string;
  skillId: string;
  status: 'pending' | 'verifying' | 'installing' | 'completed' | 'failed';
  progress: number;
  error?: string;
}

export async function fetchSkills(
  page = 1,
  pageSize = 20,
  filter?: { state?: string; type?: string },
): Promise<{ skills: SkillListItem[]; total: number; page: number }> {
  const params = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
  if (filter?.state) params.append('state', filter.state);
  if (filter?.type) params.append('type', filter.type);
  const res = await api.get(`/skills?${params}`);
  return res.data;
}

export async function searchSkills(keyword: string, page = 1, pageSize = 20): Promise<{ skills: SkillListItem[]; total: number }> {
  const params = new URLSearchParams({ q: keyword, page: String(page), pageSize: String(pageSize) });
  const res = await api.get(`/skills/search?${params}`);
  return res.data;
}

export async function fetchSkillDetail(skillId: string): Promise<SkillListItem & { signatureChain: SignatureChainResult }> {
  const res = await api.get(`/skills/${skillId}`);
  return res.data;
}

export async function installSkill(skillId: string, tenantId: string, approvedBy: string): Promise<InstallTask> {
  const res = await api.post(`/skills/${skillId}/install`, { tenantId, approvedBy });
  return res.data;
}

export async function getInstallStatus(taskId: string): Promise<InstallTask | null> {
  const res = await api.get(`/skills/tasks/${taskId}`);
  return res.data;
}

export async function verifySignature(skillId: string): Promise<SignatureChainResult> {
  const res = await api.post('/skills/verify-signature', { skillId });
  return res.data;
}

export async function fetchCategories(): Promise<{ type: string; count: number }[]> {
  const res = await api.get('/skills/categories');
  return res.data;
}
