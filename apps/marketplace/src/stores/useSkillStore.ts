import { defineStore } from 'pinia';
import { ref } from 'vue';
import {
  fetchSkills,
  searchSkills,
  fetchSkillDetail,
  installSkill as apiInstallSkill,
  getInstallStatus,
  fetchCategories,
} from '../api/market';
import type { SkillListItem, InstallTask, SignatureChainResult } from '../api/market';

export const useSkillStore = defineStore('skill', () => {
  const skills = ref<SkillListItem[]>([]);
  const total = ref(0);
  const loading = ref(false);
  const selectedSkill = ref<SkillListItem | null>(null);
  const signatureChain = ref<SignatureChainResult | null>(null);
  const categories = ref<{ type: string; count: number }[]>([]);
  const installTasks = ref<Map<string, InstallTask>>(new Map());

  async function loadSkills(page = 1, pageSize = 20, filter?: { state?: string; type?: string }) {
    loading.value = true;
    try {
      const res = await fetchSkills(page, pageSize, filter);
      skills.value = res.skills;
      total.value = res.total;
    } finally {
      loading.value = false;
    }
  }

  async function search(keyword: string, page = 1, pageSize = 20) {
    loading.value = true;
    try {
      const res = await searchSkills(keyword, page, pageSize);
      skills.value = res.skills;
      total.value = res.total;
    } finally {
      loading.value = false;
    }
  }

  async function loadSkillDetail(skillId: string) {
    const detail = await fetchSkillDetail(skillId);
    selectedSkill.value = detail;
    signatureChain.value = detail.signatureChain;
    return detail;
  }

  async function loadCategories() {
    categories.value = await fetchCategories();
  }

  async function installSkill(skillId: string, tenantId: string, approvedBy: string): Promise<InstallTask> {
    const task = await apiInstallSkill(skillId, tenantId, approvedBy);
    installTasks.value.set(task.taskId, task);
    return task;
  }

  async function pollInstallStatus(taskId: string): Promise<InstallTask | null> {
    const task = await getInstallStatus(taskId);
    if (task) {
      installTasks.value.set(taskId, task);
    }
    return task;
  }

  function getTask(taskId: string): InstallTask | undefined {
    return installTasks.value.get(taskId);
  }

  return {
    skills,
    total,
    loading,
    selectedSkill,
    signatureChain,
    categories,
    installTasks,
    loadSkills,
    search,
    loadSkillDetail,
    loadCategories,
    installSkill,
    pollInstallStatus,
    getTask,
  };
});
