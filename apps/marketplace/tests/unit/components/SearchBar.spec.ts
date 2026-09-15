import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import SearchBar from '@/components/SearchBar.vue';

describe('SearchBar', () => {
  it('emits search event with keyword', async () => {
    const wrapper = mount(SearchBar);
    const input = wrapper.find('input');
    await input.setValue('auth-tool');
    await wrapper.find('button[type="submit"]').trigger('click');
    expect(wrapper.emitted('search')).toHaveLength(1);
    expect(wrapper.emitted('search')![0]).toEqual(['auth-tool']);
  });

  it('emits clear event when clear button clicked', async () => {
    const wrapper = mount(SearchBar);
    await wrapper.find('button.clear').trigger('click');
    expect(wrapper.emitted('clear')).toBeDefined();
  });

  it('displays placeholder text', () => {
    const wrapper = mount(SearchBar);
    expect(wrapper.find('input').attributes('placeholder')).toContain('Search');
  });
});
