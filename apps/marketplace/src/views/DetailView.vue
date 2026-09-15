<template>
  <div v-if="detail" class="detail-view">
    <button class="back-btn" @click="router.back()">← Back</button>
    <h1 class="page-title">{{ detail.name }}</h1>

    <div class="info-grid">
      <div class="info-item">
        <span class="info-label">Version</span>
        <span class="info-value">v{{ detail.version }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Type</span>
        <span class="info-value">{{ detail.type }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Risk Tier</span>
        <span :class="['info-value', `risk-${detail.riskTier}`]">{{ detail.riskTier }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">State</span>
        <span class="info-value">{{ detail.state }}</span>
      </div>
      <div class="info-item">
        <span class="info-label">Installed At</span>
        <span class="info-value">{{ new Date(detail.installedAt).toLocaleDateString() }}</span>
      </div>
    </div>

    <p class="description">{{ detail.description }}</p>

    <div v-if="detail.tags.length > 0" class="tags">
      <span v-for="tag in detail.tags" :key="tag" class="tag">{{ tag }}</span>
    </div>

    <SignatureChain :result="signatureChain" />

    <div class="actions">
      <button
        class="install-btn"
        :disabled="detail.state !== 'active' || !signatureChain?.overall === 'failed'"
        @click="goToInstall"
      >
        Install
      </button>
    </div>
  </div>

  <div v-else class="loading">Loading skill details...</div>
</template>

<script setup lang="ts">
import { onMounted, ref } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useSkillStore } from '@/stores/useSkillStore';
import SignatureChain from '@/components/SignatureChain.vue';

const route = useRoute();
const router = useRouter();
const store = useSkillStore();

const detail = ref<any>(null);
const signatureChain = ref<any>(null);

onMounted(async () => {
  const skillId = route.params.skillId as string;
  const result = await store.loadSkillDetail(skillId);
  detail.value = result;
  signatureChain.value = result.signatureChain;
});

function goToInstall() {
  router.push({ name: 'install', params: { skillId: route.params.skillId } });
}
</script>

<style scoped>
.detail-view {
  max-width: 800px;
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
  font-size: 1.75rem;
  font-weight: 700;
  margin-bottom: 1.5rem;
}

.info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 1.5rem;
}

.info-item {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.info-label {
  font-size: 0.75rem;
  color: var(--color-text-muted);
  text-transform: uppercase;
}

.info-value {
  font-size: 1rem;
  font-weight: 500;
}

.risk-G1 { color: var(--color-success); }
.risk-G2 { color: var(--color-warning); }
.risk-G3 { color: #c2410c; }
.risk-G4 { color: var(--color-danger); }

.description {
  color: var(--color-text-muted);
  line-height: 1.6;
  margin-bottom: 1rem;
}

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-bottom: 1.5rem;
}

.tag {
  font-size: 0.75rem;
  padding: 0.125rem 0.5rem;
  background: var(--color-bg);
  border-radius: 4px;
  color: var(--color-text-muted);
}

.actions {
  margin-top: 1.5rem;
}

.install-btn {
  padding: 0.75rem 2rem;
  background: var(--color-primary);
  color: white;
  border: none;
  border-radius: var(--radius);
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
}

.install-btn:hover:not(:disabled) {
  background: var(--color-primary-hover);
}

.install-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading {
  text-align: center;
  padding: 3rem;
  color: var(--color-text-muted);
}
</style>
