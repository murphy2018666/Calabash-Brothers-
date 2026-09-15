<template>
  <div v-if="skill" class="install-view">
    <button class="back-btn" @click="router.back()">← Back</button>
    <h1 class="page-title">Install {{ skill.name }}</h1>

    <!-- Step 1: Confirm -->
    <div v-if="step === 1" class="step">
      <h2>Step 1: Confirm Installation</h2>
      <div class="confirm-info">
        <div class="info-row"><span class="label">Skill:</span><span>{{ skill.name }}</span></div>
        <div class="info-row"><span class="label">Version:</span><span>v{{ skill.version }}</span></div>
        <div class="info-row"><span class="label">Type:</span><span>{{ skill.type }}</span></div>
        <div class="info-row"><span class="label">Risk Tier:</span><span :class="`risk-${skill.riskTier}`">{{ skill.riskTier }}</span></div>
      </div>
      <div class="form-group">
        <label>Tenant ID</label>
        <input v-model="tenantId" type="text" placeholder="Enter tenant ID" />
      </div>
      <div class="form-group">
        <label>Approved By</label>
        <input v-model="approvedBy" type="text" placeholder="Your name / ID" />
      </div>
      <button class="continue-btn" :disabled="!tenantId.trim() || !approvedBy.trim()" @click="step = 2">
        Continue
      </button>
    </div>

    <!-- Step 2: Signature Verification -->
    <div v-else-if="step === 2" class="step">
      <h2>Step 2: Signature Verification</h2>
      <SignatureChain :result="signatureChain" />
      <div class="step-actions">
        <button v-if="signatureChain?.overall === 'passed'" class="continue-btn" @click="startInstall">
          Start Installation
        </button>
        <button v-else class="retry-btn" @click="verifyAgain">
          Retry Verification
        </button>
      </div>
    </div>

    <!-- Step 3: Installation Progress -->
    <div v-else-if="step === 3" class="step">
      <h2>Step 3: Installing...</h2>
      <InstallProgress :task="installTask" />
    </div>

    <!-- Step 4: Complete -->
    <div v-else-if="step === 4" class="step">
      <div class="complete-msg">
        <span class="icon">✓</span>
        <h2>Installation Complete!</h2>
        <p>{{ installTask?.status === 'completed' ? 'Skill has been installed successfully.' : installTask?.error }}</p>
      </div>
      <button class="done-btn" @click="router.push({ name: 'detail', params: { skillId } })">
        Back to Detail
      </button>
    </div>
  </div>

  <div v-else class="loading">Loading...</div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSkillStore } from '@/stores/useSkillStore';
import type { InstallTask, SignatureChainResult } from '@/api/market';
import SignatureChain from '@/components/SignatureChain.vue';
import InstallProgress from '@/components/InstallProgress.vue';

const route = useRoute();
const router = useRouter();
const store = useSkillStore();

const skillId = route.params.skillId as string;
const skill = ref<any>(null);
const signatureChain = ref<SignatureChainResult | null>(null);
const installTask = ref<InstallTask | null>(null);
const step = ref(1);
const tenantId = ref('default');
const approvedBy = ref('');

let pollTimer: ReturnType<typeof setInterval> | null = null;

async function verifyAgain() {
  const detail = await store.loadSkillDetail(skillId);
  signatureChain.value = detail.signatureChain;
}

async function startInstall() {
  step.value = 3;
  const task = await store.installSkill(skillId, tenantId.value, approvedBy.value);
  installTask.value = task;
  pollInstall(task.taskId);
}

function pollInstall(taskId: string) {
  pollTimer = setInterval(async () => {
    const t = await store.pollInstallStatus(taskId);
    if (t && (t.status === 'completed' || t.status === 'failed')) {
      installTask.value = t;
      if (pollTimer) clearInterval(pollTimer);
      step.value = 4;
    }
  }, 2000);
}

onMounted(async () => {
  const detail = await store.loadSkillDetail(skillId);
  skill.value = detail;
  signatureChain.value = detail.signatureChain;
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<style scoped>
.install-view {
  max-width: 600px;
  margin: 0 auto;
}

.back-btn {
  background: none;
  border: none;
  color: var(--color-primary);
  cursor: pointer;
  font-size: 0.875rem;
  padding: 0;
  margin-bottom: 1rem;
}

.page-title {
  font-size: 1.5rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
}

.step {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 1.5rem;
}

.step h2 {
  font-size: 1.125rem;
  margin-bottom: 1rem;
}

.confirm-info {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
  margin-bottom: 1.5rem;
}

.info-row {
  display: flex;
  gap: 1rem;
  padding: 0.5rem;
  background: var(--color-bg);
  border-radius: 4px;
}

.info-row .label {
  font-weight: 600;
  color: var(--color-text-muted);
  min-width: 100px;
}

.risk-G1 { color: var(--color-success); }
.risk-G2 { color: var(--color-warning); }
.risk-G3 { color: #c2410c; }
.risk-G4 { color: var(--color-danger); }

.form-group {
  display: flex;
  flex-direction: column;
  gap: 0.375rem;
  margin-bottom: 1rem;
}

.form-group label {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--color-text-muted);
}

.form-group input {
  padding: 0.5rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 1rem;
}

.step-actions {
  margin-top: 1rem;
  display: flex;
  gap: 0.5rem;
}

.continue-btn, .retry-btn, .done-btn {
  padding: 0.625rem 1.5rem;
  border-radius: var(--radius);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.continue-btn {
  background: var(--color-primary);
  color: white;
  border: none;
}

.continue-btn:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.continue-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.retry-btn {
  background: var(--color-warning);
  color: white;
  border: none;
}

.done-btn {
  background: var(--color-success);
  color: white;
  border: none;
}

.complete-msg {
  text-align: center;
  padding: 2rem;
}

.complete-msg .icon {
  font-size: 3rem;
  display: block;
  margin-bottom: 1rem;
}

.loading {
  text-align: center;
  padding: 3rem;
  color: var(--color-text-muted);
}
</style>
