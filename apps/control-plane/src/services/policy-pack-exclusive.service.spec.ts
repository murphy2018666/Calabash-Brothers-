/**
 * PolicyPackExclusiveService 单元测试（K18-2）。
 * TDD 策略：先定义测试契约，再实现服务。
 */

import { PolicyPackExclusiveService } from './policy-pack-exclusive.service';

describe('PolicyPackExclusiveService (K18-2)', () => {
  let service: PolicyPackExclusiveService;

  beforeEach(() => {
    service = new PolicyPackExclusiveService();
  });

  afterEach(() => {
    service.clear();
  });

  // ── 创建独占包 ──

  it('createExclusivePack: creates a new exclusive pack', () => {
    const pack = service.createExclusivePack('t-1', 'pack-1', ['policy-a', 'policy-b']);
    expect(pack).toBeDefined();
    expect(pack.packId).toBeTruthy();
    expect(pack.tenantId).toBe('t-1');
    expect(pack.packName).toBe('pack-1');
    expect(pack.status).toBe('draft');
    expect(pack.policies).toEqual(['policy-a', 'policy-b']);
  });

  it('createExclusivePack: generates unique packId', () => {
    const p1 = service.createExclusivePack('t-1', 'pack-x', []);
    const p2 = service.createExclusivePack('t-1', 'pack-y', []);
    expect(p1.packId).not.toBe(p2.packId);
  });

  // ── 发布 ──

  it('publishPack: changes status to published', () => {
    const pack = service.createExclusivePack('t-2', 'pub-pack', ['pol-1']);
    const published = service.publishPack(pack.packId);
    expect(published.status).toBe('published');
  });

  it('publishPack: publishes with default policies if none specified', () => {
    const pack = service.createExclusivePack('t-2b', 'pub-pack-empty', []);
    const published = service.publishPack(pack.packId);
    expect(published.status).toBe('published');
  });

  it('publishPack: throws for non-existent pack', () => {
    expect(() => service.publishPack('fake-pack-id')).toThrow();
  });

  // ── 查询可用包 ──

  it('getAvailablePacks: returns packs accessible to tenant', () => {
    const pack1 = service.createExclusivePack('t-query', 'q-pack-1', ['pol-1']);
    service.publishPack(pack1.packId);
    const packs = service.getAvailablePacks('t-query');
    expect(packs).toHaveLength(1);
    expect(packs[0].packId).toBe(pack1.packId);
  });

  it('getAvailablePacks: includes granted packs from other tenants', () => {
    const otherPack = service.createExclusivePack('t-other', 'other-pack', ['pol-x']);
    service.publishPack(otherPack.packId);
    service.grantAccess(otherPack.packId, 't-grantee');

    const packs = service.getAvailablePacks('t-grantee');
    expect(packs.some((p) => p.packId === otherPack.packId)).toBe(true);
  });

  // ── 授权/撤销访问 ──

  it('grantAccess: grants another tenant access', () => {
    const pack = service.createExclusivePack('t-owner', 'grant-pack', ['pol-1']);
    service.publishPack(pack.packId);
    const granted = service.grantAccess(pack.packId, 't-grantee');
    expect(granted).toBe(true);
  });

  it('grantAccess: returns false if not published', () => {
    const pack = service.createExclusivePack('t-owner', 'no-grant', ['pol-1']);
    const granted = service.grantAccess(pack.packId, 't-grantee');
    expect(granted).toBe(false);
  });

  it('revokeAccess: revokes another tenant\'s access', () => {
    const pack = service.createExclusivePack('t-owner2', 'revoke-pack', ['pol-1']);
    service.publishPack(pack.packId);
    service.grantAccess(pack.packId, 't-grantee2');
    const revoked = service.revokeAccess(pack.packId, 't-grantee2');
    expect(revoked).toBe(true);

    const remaining = service.getAvailablePacks('t-grantee2');
    expect(remaining.some((p) => p.packId === pack.packId)).toBe(false);
  });

  it('revokeAccess: owner always retains access', () => {
    const pack = service.createExclusivePack('t-owner3', 'owner-always', ['pol-1']);
    service.publishPack(pack.packId);
    service.grantAccess(pack.packId, 't-other3');
    service.revokeAccess(pack.packId, 't-other3');

    const packs = service.getAvailablePacks('t-owner3');
    expect(packs.some((p) => p.packId === pack.packId)).toBe(true);
  });
});
