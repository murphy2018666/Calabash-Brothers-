import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SignatureChain from '@/components/SignatureChain.vue';
import ChainStep from '@/components/ChainStep.vue';
import type { SignatureChainResult } from '@/api/market';

const makeResult = (overrides: Partial<SignatureChainResult> = {}): SignatureChainResult => ({
  cosign: { ok: true, details: 'cosign verified' },
  certificate: { ok: true, details: 'fulcio cert valid' },
  rekor: { ok: true, details: 'rekor entry found' },
  compliance: { ok: true, details: 'policy compliant' },
  overall: 'passed',
  ...overrides,
});

describe('SignatureChain', () => {
  it('shows loading text when result is null', () => {
    const wrapper = mount(SignatureChain, { props: { result: null } });
    expect(wrapper.find('.chain-loading').text()).toContain('Loading verification');
    expect(wrapper.find('.chain-steps').exists()).toBe(false);
  });

  it('renders four chain steps when result provided', () => {
    const wrapper = mount(SignatureChain, { props: { result: makeResult() } });
    const steps = wrapper.findAllComponents(ChainStep);
    expect(steps).toHaveLength(4);
    expect(steps[0].props('label')).toBe('Cosign Signature');
    expect(steps[1].props('label')).toBe('Fulcio Certificate');
    expect(steps[2].props('label')).toBe('Rekor Transparency Log');
    expect(steps[3].props('label')).toBe('Policy Compliance');
  });

  it('shows passed result when overall is passed', () => {
    const wrapper = mount(SignatureChain, { props: { result: makeResult() } });
    expect(wrapper.find('.chain-result.passed').exists()).toBe(true);
    expect(wrapper.find('.result-text').text()).toContain('verified');
  });

  it('shows failed result when overall is failed', () => {
    const wrapper = mount(SignatureChain, { props: { result: makeResult({ overall: 'failed' }) } });
    expect(wrapper.find('.chain-result.failed').exists()).toBe(true);
    expect(wrapper.find('.result-text').text()).toContain('failed');
  });

  it('passes correct ok values to chain steps', () => {
    const result = makeResult({
      cosign: { ok: true },
      certificate: { ok: false },
      rekor: { ok: true },
      compliance: { ok: false },
      overall: 'failed',
    });
    const wrapper = mount(SignatureChain, { props: { result } });
    const steps = wrapper.findAllComponents(ChainStep);
    expect(steps[0].props('ok')).toBe(true);
    expect(steps[1].props('ok')).toBe(false);
    expect(steps[2].props('ok')).toBe(true);
    expect(steps[3].props('ok')).toBe(false);
  });
});
