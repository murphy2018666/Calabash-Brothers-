import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2, OnEvent } from '@nestjs/event-emitter';
import type { DomainEvent } from '@aegisci/shared/types';
import type { CredentialScope, IssuedCredential } from '@aegisci/core/spi/secrets';

/**
 * ApprovalCompleted 事件载荷 —— 本子域本地声明，结构对齐 Approval 子域契约。
 * 不反向 import Approval（遵守"目录即边界"），仅以事件名为契约。
 */
interface ApprovalCompletedPayload {
  readonly ticketId: string;
  readonly evidenceId: string;
  readonly tenantId: string;
  readonly approvedBy: readonly string[];
  readonly quorum: number;
}

/** SkillRevoked 事件载荷 —— 本地声明，结构对齐 Skill 子域契约。 */
interface SkillRevokedPayload {
  readonly skillId: string;
  readonly principalId: string;
}

/** JTI 登记册条目。 */
export interface JtiRegistryEntry {
  readonly jti: string;
  readonly principal: string;
  readonly evidenceId: string;
  readonly scope: CredentialScope;
  readonly expiresAt: string;
  readonly revoked: boolean;
}

/**
 * JTI 登记册抽象 —— Redis 主存（凭证熔断清单）。
 * 由基础设施层注入实现；本子域不直接持有 Redis 客户端。
 */
export const CREDENTIAL_JTI_REGISTRY = Symbol('CREDENTIAL_JTI_REGISTRY');

export interface CredentialJtiRegistry {
  register(
    jti: string,
    entry: Omit<JtiRegistryEntry, 'jti' | 'revoked'>,
    ttlSeconds: number,
  ): Promise<void>;
  revoke(jti: string): Promise<void>;
  listByPrincipal(principal: string): Promise<string[]>;
  isRevoked(jti: string): Promise<boolean>;
}

/** TTL 上限：≤30min（DES-5.3 / FR-M7-05 不变式）。 */
const MAX_TTL_SECONDS = 30 * 60;

/**
 * Credential 子域 —— 短时凭证签发/回收/熔断（DES-5.3 风暴路径）。
 *
 * 域内交互约束：
 * - 不复算裁决：签发仅消费 Decision 的 evidenceId（单一证据来源）。
 * - 持久化：Redis JTI 登记册（主）+ PG policy_credential_* 留痕。
 * - 熔断广播 ≤10s 全节点生效（FR-M3-07）：经 NATS JetStream 广播 TokenRevoked/EmergencyFrozen。
 */
@Injectable()
export class CredentialService {
  private readonly logger = new Logger(CredentialService.name);

  constructor(
    @Inject(CREDENTIAL_JTI_REGISTRY) private readonly registry: CredentialJtiRegistry,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * 签发短时凭证 —— scope 由 Policy 裁决注入，本服务无权扩大 scope 或延长 TTL。
   * 仅消费 evidenceId，不复算裁决。
   */
  async issue(
    evidenceId: string,
    scope: CredentialScope,
    principal: string,
  ): Promise<IssuedCredential> {
    const ttl = Math.min(scope.ttl, MAX_TTL_SECONDS);
    const jti = randomUUID();
    const expiresAt = new Date(Date.now() + ttl * 1000).toISOString();
    const scoped: CredentialScope = { ...scope, ttl };
    const token = this.encodeToken({ jti, principal, evidenceId, scope: scoped, expiresAt });

    await this.registry.register(jti, { principal, evidenceId, scope: scoped, expiresAt }, ttl);
    return {
      credentialId: randomUUID(),
      token,
      scope: scoped,
      expiresAt,
      jti,
    };
  }

  /** 吊销单凭证 —— 熔断广播 TokenRevoked（≤10s 全节点生效）。 */
  async revoke(jti: string): Promise<void> {
    await this.registry.revoke(jti);
    this.events.emit('TokenRevoked', { jti, timestamp: new Date().toISOString() });
  }

  /** 批量吊销（熔断）—— 全节点生效 ≤10s（FR-M3-07）。 */
  async revokeAll(principal: string): Promise<string[]> {
    const jtis = await this.registry.listByPrincipal(principal);
    await Promise.all(jtis.map((j) => this.registry.revoke(j)));
    this.events.emit('EmergencyFrozen', {
      principal,
      jtis,
      timestamp: new Date().toISOString(),
    });
    return jtis;
  }

  /** 消费 ApprovalCompleted —— 签发 deploy token，仅使用 evidenceId（不复算裁决）。 */
  @OnEvent('ApprovalCompleted')
  async handleApprovalCompleted(event: DomainEvent<ApprovalCompletedPayload>): Promise<void> {
    const { evidenceId, tenantId, approvedBy } = event.payload;
    if (approvedBy.length === 0) {
      this.logger.warn(`ApprovalCompleted without approvers: ${event.aggregateId}`);
      return;
    }
    // 部署凭证 scope 由策略预设注入；此处仅消费 evidenceId 签发，不复算裁决。
    const deployScope: CredentialScope = {
      actions: ['deploy'],
      resources: [],
      environment: tenantId,
      ttl: MAX_TTL_SECONDS,
    };
    await this.issue(evidenceId, deployScope, approvedBy[0] ?? 'system');
  }

  /** 消费 SkillRevoked —— 技能吊销级联回收 Token（≤10s，DES-11.3）。 */
  @OnEvent('SkillRevoked')
  async handleSkillRevoked(event: DomainEvent<SkillRevokedPayload>): Promise<void> {
    await this.revokeAll(event.payload.principalId);
  }

  private encodeToken(claims: {
    jti: string;
    principal: string;
    evidenceId: string;
    scope: CredentialScope;
    expiresAt: string;
  }): string {
    // 骨架：真实实现为 ed25519 签名 JWT；网关侧用公钥验签。此处仅占位编码。
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${body}.skeleton-signature`;
  }
}
