import { describe, it, expect, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import SkillCard from '@/components/SkillCard.vue';
import type { SkillListItem } from '@/api/market';

const makeSkill = (overrides: Partial<SkillListItem> = {}): SkillListItem => ({
  skillId: 'skill-1',
  name: 'auth-tool',
  version: '1.0.0',
  type: 'tool',
  description: 'An authentication security tool',
  riskTier: 'G2',
  state: 'active',
  signatureVerified: true,
  tags: ['auth', 'security'],
  installedAt: '2024-01-01T00:00:00Z',
  ...overrides,
});

describe('SkillCard', () => {
  it('renders skill name and type badge', () => {
    const wrapper = mount(SkillCard, { props: { skill: makeSkill() } });
    expect(wrapper.text()).toContain('auth-tool');
    expect(wrapper.find('.type-badge').text()).toBe('tool');
  });

  it('shows disabled style when state is not active', () => {
    const wrapper = mount(SkillCard, { props: { skill: makeSkill({ state: 'disabled' }) } });
    expect(wrapper.find('.skill-card').classes('disabled')).toBe(true);
  });

  it('displays correct risk tier color class', () => {
    const wrapper = mount(SkillCard, { props: { skill: makeSkill({ riskTier: 'G3' }) } });
    expect(wrapper.find('.risk-G3').exists()).toBe(true);
  });

  it('shows signed status when signatureVerified is true', () => {
    const wrapper = mount(SkillCard, { props: { skill: makeSkill({ signatureVerified: true }) } });
    expect(wrapper.find('.sig-status.verified').exists()).toBe(true);
  });

  it('shows unsigned status when signatureVerified is false', () => {
    const wrapper = mount(SkillCard, { props: { skill: makeSkill({ signatureVerified: false }) } });
    expect(wrapper.find('.sig-status.unverified').exists()).toBe(true);
  });

  it('renders tags when provided', () => {
    const wrapper = mount(SkillCard, { props: { skill: makeSkill({ tags: ['auth', 'security', 'compliance'] }) } });
    const tags = wrapper.findAll('.tag');
    expect(tags).toHaveLength(3);
    expect(tags[0].text()).toBe('auth');
  });

  it('does not render tags container when tags is empty', () => {
    const wrapper = mount(SkillCard, { props: { skill: makeSkill({ tags: [] }) } });
    expect(wrapper.find('.tags').exists()).toBe(false);
  });

  it('emits click event when clicked', async () => {
    const wrapper = mount(SkillCard, { props: { skill: makeSkill() } });
    await wrapper.trigger('click');
    expect(wrapper.emitted('click')).toHaveLength(1);
  });
});
