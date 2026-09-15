<template>
  <div class="install-progress">
    <div class="progress-header">
      <span class="progress-label">Installation Progress</span>
      <span class="progress-percent">{{ task?.progress ?? 0 }}%</span>
    </div>
    <div class="progress-bar">
      <div
        class="progress-fill"
        :style="{ width: `${task?.progress ?? 0}%` }"
        :class="task?.status"
      ></div>
    </div>
    <div class="progress-status">
      <span :class="['status-badge', task?.status]">
        {{ task?.status ? task.status.charAt(0).toUpperCase() + task.status.slice(1) : 'Pending' }}
      </span>
      <span v-if="task?.error" class="error-msg">{{ task.error }}</span>
    </div>
    <div v-if="task?.status === 'completed'" class="success-msg">
      ✓ Installation completed successfully
    </div>
    <div v-else-if="task?.status === 'failed'" class="failure-msg">
      ✗ Installation failed
    </div>
  </div>
</template>

<script setup lang="ts">
import type { InstallTask } from '@/api/market';

defineProps<{ task: InstallTask | null }>();
</script>

<style scoped>
.install-progress {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 1rem;
}

.progress-header {
  display: flex;
  justify-content: space-between;
  font-size: 0.875rem;
  margin-bottom: 0.5rem;
}

.progress-bar {
  height: 8px;
  background: var(--color-border);
  border-radius: 4px;
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  transition: width 0.3s ease;
}

.progress-fill.pending { background: var(--color-text-muted); }
.progress-fill.verifying { background: var(--color-warning); }
.progress-fill.installing { background: var(--color-primary); }
.progress-fill.completed { background: var(--color-success); }
.progress-fill.failed { background: var(--color-danger); }

.progress-status {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin-top: 0.5rem;
  font-size: 0.875rem;
}

.status-badge {
  font-weight: 600;
  text-transform: capitalize;
}

.error-msg {
  color: var(--color-danger);
  font-size: 0.8rem;
}

.success-msg {
  color: var(--color-success);
  font-weight: 600;
  margin-top: 0.5rem;
}

.failure-msg {
  color: var(--color-danger);
  font-weight: 600;
  margin-top: 0.5rem;
}
</style>
