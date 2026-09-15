<template>
  <div class="signature-chain">
    <h3 class="chain-title">Signature Chain Verification</h3>
    <div v-if="result" class="chain-steps">
      <ChainStep label="Cosign Signature" :ok="result.cosign.ok" :details="result.cosign.details" />
      <ChainStep label="Fulcio Certificate" :ok="result.certificate.ok" :details="result.certificate.details" />
      <ChainStep label="Rekor Transparency Log" :ok="result.rekor.ok" :details="result.rekor.details" />
      <ChainStep label="Policy Compliance" :ok="result.compliance.ok" :details="result.compliance.details" />
    </div>
    <div v-else class="chain-loading">Loading verification...</div>

    <div :class="['chain-result', result?.overall === 'passed' ? 'passed' : 'failed']">
      <span class="result-icon">{{ result?.overall === 'passed' ? '✓' : '✗' }}</span>
      <span class="result-text">
        {{ result?.overall === 'passed' ? 'Signature chain verified' : 'Signature chain verification failed' }}
      </span>
    </div>
  </div>
</template>

<script setup lang="ts">
import type { SignatureChainResult } from '@/api/market';
import ChainStep from './ChainStep.vue';

defineProps<{ result: SignatureChainResult | null }>();
</script>

<style scoped>
.signature-chain {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius);
  padding: 1rem;
  margin-top: 1rem;
}

.chain-title {
  font-size: 1rem;
  font-weight: 600;
  margin-bottom: 0.75rem;
}

.chain-result {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-top: 0.75rem;
  padding: 0.5rem;
  border-radius: var(--radius);
  font-weight: 600;
}

.chain-result.passed {
  background: #dcfce7;
  color: #166534;
}

.chain-result.failed {
  background: #fecaca;
  color: #991b1b;
}

.result-icon {
  font-size: 1.25rem;
}

.chain-loading {
  color: var(--color-text-muted);
  font-style: italic;
}
</style>
