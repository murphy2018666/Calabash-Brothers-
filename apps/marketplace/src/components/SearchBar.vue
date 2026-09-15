<template>
  <div class="search-bar">
    <input
      v-model="input"
      type="text"
      placeholder="Search skills by name, description, or tag..."
      class="search-input"
      @keyup.enter="handleSearch"
    />
    <button class="search-btn" @click="handleSearch" :disabled="!input.trim()">
      Search
    </button>
    <button v-if="currentKeyword" class="clear-btn" @click="handleClear">
      Clear
    </button>
  </div>
</template>

<script setup lang="ts">
import { ref, watch } from 'vue';

const props = defineProps<{ keyword?: string }>();
const emit = defineEmits<{ search: [keyword: string]; clear: [] }>();

const input = ref(props.keyword ?? '');
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

watch(() => props.keyword, (val) => {
  input.value = val ?? '';
});

function handleSearch() {
  emit('search', input.value.trim());
}

function handleClear() {
  input.value = '';
  emit('clear');
}
</script>

<style scoped>
.search-bar {
  display: flex;
  gap: 0.5rem;
}

.search-input {
  flex: 1;
  padding: 0.625rem 1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  font-size: 1rem;
  outline: none;
  transition: border-color 0.2s;
}

.search-input:focus {
  border-color: var(--color-primary);
}

.search-btn, .clear-btn {
  padding: 0.625rem 1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.search-btn:hover:not(:disabled) {
  background: var(--color-primary);
  color: white;
  border-color: var(--color-primary);
}

.search-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.clear-btn:hover {
  background: var(--color-bg);
  color: var(--color-danger);
}
</style>
