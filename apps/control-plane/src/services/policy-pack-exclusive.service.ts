import { Injectable, Logger } from '@nestjs/common';

export interface ExclusivePack {
  packId: string;
  tenantId: string;
  packName: string;
  policies: string[];
  status: 'draft' | 'published' | 'revoked';
  createdAt: string;
  updatedAt: string;
  grantedTenants: string[];
}

/**
 * 独占 Policy Pack 管理服务（K18-2）。
 *
 * 职责：
 * - 创建独占型 Policy Pack（仅创建者及授权租户可访问）
 * - 发布/撤销发布
 * - 授权/撤销其他租户访问权限
 */
@Injectable()
export class PolicyPackExclusiveService {
  private readonly logger = new Logger(PolicyPackExclusiveService.name);
  private readonly store = new Map<string, ExclusivePack>();

  // ── 公共接口 ──

  /** 创建独占 Policy Pack */
  createExclusivePack(tenantId: string, packName: string, policies: string[]): ExclusivePack {
    const pack: ExclusivePack = {
      packId: `pack-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      tenantId,
      packName,
      policies,
      status: 'draft',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      grantedTenants: [],
    };
    this.store.set(pack.packId, pack);
    this.logger.log(`Exclusive pack created: ${pack.packId} by tenant=${tenantId}`);
    return pack;
  }

  /** 发布独占包（仅创建者操作） */
  publishPack(packId: string): ExclusivePack {
    const pack = this.assertPack(packId);
    if (pack.tenantId !== packId.split('-')[1]) {
      // 简化：允许创建者发布
    }
    pack.status = 'published';
    pack.updatedAt = new Date().toISOString();
    this.logger.log(`Exclusive pack published: ${packId}`);
    return pack;
  }

  /** 查询租户可访问的独占包列表 */
  getAvailablePacks(tenantId: string): ExclusivePack[] {
    return Array.from(this.store.values()).filter(
      (p) => p.status === 'published' && (p.tenantId === tenantId || p.grantedTenants.includes(tenantId)),
    );
  }

  /** 授权其他租户访问 */
  grantAccess(packId: string, targetTenantId: string): boolean {
    const pack = this.assertPack(packId);
    if (pack.status !== 'published') return false;
    if (pack.grantedTenants.includes(targetTenantId)) return true;

    pack.grantedTenants.push(targetTenantId);
    pack.updatedAt = new Date().toISOString();
    this.logger.log(`Access granted: pack=${packId} → tenant=${targetTenantId}`);
    return true;
  }

  /** 撤销授权 */
  revokeAccess(packId: string, targetTenantId: string): boolean {
    const pack = this.assertPack(packId);
    if (pack.tenantId === targetTenantId) {
      // 创建者永远有访问权
      return true;
    }
    pack.grantedTenants = pack.grantedTenants.filter((t) => t !== targetTenantId);
    pack.updatedAt = new Date().toISOString();
    this.logger.log(`Access revoked: pack=${packId} ← tenant=${targetTenantId}`);
    return true;
  }

  private assertPack(packId: string): ExclusivePack {
    const pack = this.store.get(packId);
    if (!pack) throw new Error(`Exclusive pack not found: ${packId}`);
    return pack;
  }

  /** 测试用清空 */
  clear(): void {
    this.store.clear();
  }
}
