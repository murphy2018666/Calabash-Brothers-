<template>
  <div class="skill-card" :class="{ disabled: skill.state !== 'active' }">
    <div class="card-header">
      <span class="skill-name">{{ skill.name }}</span>
      <span :class="['type-badge', `type-${skill.type}`]">{{ skill.type }}</span>
    </div>
    <p class="skill-desc">{{ skill.description }}</p>
    <div class="card-meta">
      <span class="version">v{{ skill.version }}</span>
      <span :class="['risk-tier', `risk-${skill.riskTier}`]">{{ skill.riskTier }}</span>
      <span :class="['sig-status', skill.signatureVerified ? 'verified' : 'unverified']">
        {{ skill.signatureVerified ? '✓ Signed' : '○ Unsigned' }}
      </span>
    </div>
    <div v-if="skill.tags.length > 0" class="tags">
      <span v-for="tag in skill.tags" :key="tag" class="tag">{{ tag }}</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SkillListItem } from '@/api/market';

defineProps<{ skill: SkillListItem }>();
defineEmits<{ click: [] }>();
</script>

<style scoped>
.skill-card {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 1rem;
  cursor: pointer;
  transition: box-shadow 0.2s, transform 0.2s;
}

.skill-card:hover {
  box-shadow: 0 4px 12px rgba(0,0,0,0.1);
  transform: translateY(-2px);
}

.skill-card.disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.card-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.5rem;
}

.skill-name {
  font-weight: 600;
  font-size: 1rem;
  color: var(--color-text);
}

.type-badge {
  font-size: 0.75rem;
  padding: 0.125rem 0.5rem;
  border-radius: 12px;
  background: #eff6ff;
  color: var(--color-primary);
}

.type-agent { background: #fef3c7; color: #92400e; }
.type-connector { background: #fce7f3; color: #9d174d; }
.type-policy-pack { background: #ede9fe; color: #5b21b6; }

.skill-desc {
  font-size: 0.875rem;
  color: var(--color-text-muted);
  margin-bottom: 0.75rem;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-meta {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  font-size: 0.75rem;
  color: var(--color-text-muted);
  margin-bottom: 0.5rem;
}

.risk-tier {
  padding: 0.125rem 0.375rem;
  border-radius: 4px;
  font-weight: 600;
}

.risk-G1 { background: #dcfce7; color: #166534; }
.risk-G2 { background: #fef9c3; color: #854d0e; }
.risk-G3 { background: #fed7aa; color: #9a3412; }
.risk-G4 { background: #fecaca; color: #991b1b; }

.sig-status.verified { color: var(--color-success); }
.sig-status.unverified { color: var(--color-text-muted); }

.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
}

.tag {
  font-size: 0.75rem;
  padding: 0.125rem 0.375rem;
  background: var(--color-bg);
  border-radius: 4px;
  color: var(--color-text-muted);
}
</style>
