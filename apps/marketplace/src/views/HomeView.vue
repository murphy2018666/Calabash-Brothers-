<template>
  <div class="home">
    <h1 class="page-title">Skill Marketplace</h1>

    <!-- Search Bar -->
    <SearchBar :keyword="searchKeyword" @search="handleSearch" @clear="handleClear" />

    <!-- Category Filter -->
    <div v-if="categories.length > 0" class="category-bar">
      <button
        v-for="cat in categories"
        :key="cat.type"
        :class="['cat-btn', { active: filterType === cat.type }]"
        @click="filterByType(cat.type)"
      >
        {{ cat.type }} ({{ cat.count }})
      </button>
      <button v-if="filterType" class="cat-btn clear" @click="filterByType(null)">
        Clear
      </button>
    </div>

    <!-- Skills Grid -->
    <div v-if="loading" class="loading">Loading skills...</div>
    <div v-else-if="skills.length === 0" class="empty">No skills found.</div>
    <div v-else class="skill-grid">
      <SkillCard
        v-for="skill in skills"
        :key="skill.skillId"
        :skill="skill"
        @click="goToDetail(skill.skillId)"
      />
    </div>

    <!-- Pagination -->
    <div v-if="total > pageSize" class="pagination">
      <button :disabled="page <= 1" @click="prevPage">Prev</button>
      <span>Page {{ page }} of {{ totalPages }}</span>
      <button :disabled="page >= totalPages" @click="nextPage">Next</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import { useSkillStore } from '@/stores/useSkillStore';
import SkillCard from '@/components/SkillCard.vue';
import SearchBar from '@/components/SearchBar.vue';

const router = useRouter();
const store = useSkillStore();

const searchKeyword = ref('');
const filterType = ref<string | null>(null);
const page = ref(1);
const pageSize = 12;

async function loadSkills() {
  const filter = filterType.value ? { type: filterType.value } : undefined;
  await store.loadSkills(page.value, pageSize, filter);
}

async function handleSearch(keyword: string) {
  searchKeyword.value = keyword;
  page.value = 1;
  if (keyword.trim()) {
    await store.search(keyword.trim(), page.value, pageSize);
  } else {
    await loadSkills();
  }
}

function handleClear() {
  searchKeyword.value = '';
  page.value = 1;
  filterType.value = null;
  loadSkills();
}

function filterByType(type: string | null) {
  filterType.value = type;
  page.value = 1;
  loadSkills();
}

function goToDetail(skillId: string) {
  router.push({ name: 'detail', params: { skillId } });
}

async function prevPage() {
  if (page.value > 1) {
    page.value--;
    await loadSkills();
  }
}

async function nextPage() {
  if (page.value < store.total / pageSize) {
    page.value++;
    await loadSkills();
  }
}

const totalPages = () => Math.ceil(store.total / pageSize);

onMounted(async () => {
  await store.loadCategories();
  await loadSkills();
});
</script>

<style scoped>
.home {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.page-title {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--color-text);
}

.category-bar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.cat-btn {
  padding: 0.375rem 0.75rem;
  border: 1px solid var(--color-border);
  border-radius: 20px;
  background: var(--color-surface);
  cursor: pointer;
  font-size: 0.875rem;
  transition: all 0.2s;
}

.cat-btn:hover, .cat-btn.active {
  background: var(--color-primary);
  color: white;
  border-color: var(--color-primary);
}

.cat-btn.clear:hover {
  background: var(--color-danger);
  border-color: var(--color-danger);
}

.skill-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1rem;
}

.loading, .empty {
  text-align: center;
  padding: 3rem;
  color: var(--color-text-muted);
}

.pagination {
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 1rem;
  padding: 1rem;
}

.pagination button {
  padding: 0.5rem 1rem;
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  background: var(--color-surface);
  cursor: pointer;
}

.pagination button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>
