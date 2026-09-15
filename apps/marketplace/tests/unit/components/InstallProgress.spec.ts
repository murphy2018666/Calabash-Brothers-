import { describe, it, expect } from 'vitest';
import { mount } from '@vue/test-utils';
import InstallProgress from '@/components/InstallProgress.vue';
import type { InstallTask } from '@/api/market';

const makeTask = (overrides: Partial<InstallTask> = {}): InstallTask => ({
  taskId: 'task-1',
  skillId: 'skill-1',
  status: 'pending',
  progress: 0,
  ...overrides,
});

describe('InstallProgress', () => {
  it('shows pending state with 0% progress', () => {
    const wrapper = mount(InstallProgress, { props: { task: makeTask() } });
    expect(wrapper.find('.status-badge.pending').exists()).toBe(true);
    expect(wrapper.text()).toContain('0%');
  });

  it('shows installing state with progress percentage', () => {
    const wrapper = mount(InstallProgress, { props: { task: makeTask({ status: 'installing', progress: 65 }) } });
    expect(wrapper.find('.status-badge.installing').exists()).toBe(true);
    expect(wrapper.text()).toContain('65%');
    expect(wrapper.find('.progress-fill.installing').exists()).toBe(true);
  });

  it('shows completed state with success message', () => {
    const wrapper = mount(InstallProgress, { props: { task: makeTask({ status: 'completed', progress: 100 }) } });
    expect(wrapper.find('.status-badge.completed').exists()).toBe(true);
    expect(wrapper.find('.success-msg').text()).toContain('completed successfully');
    expect(wrapper.find('.failure-msg').exists()).toBe(false);
  });

  it('shows failed state with error message', () => {
    const wrapper = mount(InstallProgress, { props: { task: makeTask({ status: 'failed', progress: 30, error: 'Network timeout' }) } });
    expect(wrapper.find('.status-badge.failed').exists()).toBe(true);
    expect(wrapper.find('.failure-msg').text()).toContain('failed');
    expect(wrapper.find('.error-msg').text()).toContain('Network timeout');
  });

  it('shows verifying state with yellow progress bar', () => {
    const wrapper = mount(InstallProgress, { props: { task: makeTask({ status: 'verifying', progress: 20 }) } });
    expect(wrapper.find('.status-badge.verifying').exists()).toBe(true);
    expect(wrapper.find('.progress-fill.verifying').exists()).toBe(true);
  });

  it('handles null task gracefully', () => {
    const wrapper = mount(InstallProgress, { props: { task: null } });
    expect(wrapper.text()).toContain('Pending');
    expect(wrapper.text()).toContain('0%');
  });
});
