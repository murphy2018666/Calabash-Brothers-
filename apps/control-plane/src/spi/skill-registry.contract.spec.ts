import { Test } from '@nestjs/testing';
import type { SkillManifest } from '@aegisci/shared/types';
import { InMemorySkillRegistry } from '../providers/in-memory-skill-registry';

/**
 * SPI 契约测试 —— InMemorySkillRegistry 实现 SkillRegistrySPI 接口正确性
 * （DES-13.9：签名校验不变量 —— 未签名包拒绝；吊销级联 ≤10s 语义）。
 */
describe('InMemorySkillRegistry (SkillRegistrySPI contract)', () => {
  let registry: InMemorySkillRegistry;

  const manifest = (overrides: Partial<SkillManifest> = {}): SkillManifest => ({
    name: 'k8s-rollout',
    version: '1.0.0',
    type: 'tool',
    description: 'kubectl rollout skill',
    tools: ['k8s.rollout'],
    riskTier: 'G3',
    ...overrides,
  });

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [InMemorySkillRegistry],
    }).compile();
    registry = moduleRef.get(InMemorySkillRegistry);
  });

  it('register() creates a record in registered state with signature verification', async () => {
    const record = await registry.register(manifest(), 'sig-abc', 'tenant-1');
    expect(record.skillId).toBeTruthy();
    expect(record.state).toBe('registered');
    expect(record.signatureVerified).toBe(true); // 非空签名
    expect(record.tenantId).toBe('tenant-1');
    expect(record.installedAt).toBeTruthy();
  });

  it('register() with empty signature marks signatureVerified=false (未签名拒绝前置)', async () => {
    const record = await registry.register(manifest(), '', 'tenant-1');
    expect(record.signatureVerified).toBe(false);
  });

  it('get() returns null for unknown skill', async () => {
    expect(await registry.get('skill_nope')).toBeNull();
  });

  it('listActive() only returns active skills of the tenant', async () => {
    const r1 = await registry.register(manifest(), 'sig', 'tenant-1');
    await registry.register(manifest({ name: 'other' }), 'sig', 'tenant-2');
    // 未 enable 前不在 active 列表
    expect(await registry.listActive('tenant-1')).toEqual([]);

    await registry.enable(r1.skillId, 'admin-1');
    const active = await registry.listActive('tenant-1');
    expect(active).toHaveLength(1);
    expect(active[0].skillId).toBe(r1.skillId);
  });

  it('enable() transitions registered → active (审计 approvedBy 参数)', async () => {
    const record = await registry.register(manifest(), 'sig', 'tenant-1');
    await registry.enable(record.skillId, 'admin-1');
    const loaded = await registry.get(record.skillId);
    expect(loaded?.state).toBe('active');
  });

  it('revoke() transitions to revoked and removes from active list (吊销级联前置)', async () => {
    const record = await registry.register(manifest(), 'sig', 'tenant-1');
    await registry.enable(record.skillId, 'admin-1');
    await registry.revoke(record.skillId);
    expect((await registry.get(record.skillId))?.state).toBe('revoked');
    expect(await registry.listActive('tenant-1')).toEqual([]);
  });

  it('enable/revoke on unknown skill is a no-op', async () => {
    await expect(registry.enable('skill_nope', 'admin-1')).resolves.toBeUndefined();
    await expect(registry.revoke('skill_nope')).resolves.toBeUndefined();
  });

  it('healthy() returns true', async () => {
    expect(await registry.healthy()).toBe(true);
  });
});
