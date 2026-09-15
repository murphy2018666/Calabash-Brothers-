<template>
  <div class="chain-step">
    <div class="step-header" @click="toggle">
      <span :class="['step-icon', ok ? 'ok' : 'fail']">{{ ok ? '✓' : '✗' }}</span>
      <span class="step-label">{{ label }}</span>
      <span class="step-toggle">{{ expanded ? '▲' : '▼' }}</span>
    </div>
    <div v-if="expanded && details" class="step-details">
      <p>{{ details }}</p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref } from 'vue';

const props = defineProps<{ label: string; ok: boolean; details?: string }>();
const expanded = ref(false);

function toggle() {
  if (props.details) expanded.value = !expanded.value;
}
</script>

<style scoped>
.chain-step {
  border-bottom: 1px solid var(--color-border);
  padding: 0.5rem 0;
}

.chain-step:last-child {
  border-bottom: none;
}

.step-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  cursor: pointer;
  user-select: none;
}

.step-icon {
  font-weight: 700;
  width: 1.25rem;
}

.step-icon.ok { color: var(--color-success); }
.step-icon.fail { color: var(--color-danger); }

.step-label {
  flex: 1;
  font-size: 0.875rem;
}

.step-toggle {
  font-size: 0.75rem;
  color: var(--color-text-muted);
}

.step-details {
  margin-left: 1.75rem;
  font-size: 0.8rem;
  color: var(--color-text-muted);
  padding: 0.25rem 0;
}
</style>
