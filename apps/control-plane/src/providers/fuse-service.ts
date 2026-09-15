import { randomUUID } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import type { DomainEvent } from '@aegisci/shared/types';
import { FUSE_CIRCUIT, type FuseBroadcast, type FuseCircuitPort } from './in-memory-fuse-circuit';
import type { CredentialScope, IssuedCredential } from '@aegisci/core/spi/secrets';
import {
  CREDENTIAL_JTI_REGISTRY,
  type CredentialJtiRegistry,
} from '@aegisci/domain/policy/credential';

/**
 * FuseService —— Token 熔断广播服务（F3）。
 *
 * 职责：
 * - emergencyFreeze(principal) → revokeAll + broadcast ≤10s
 * - revoke(jti) → 单凭证吊销
 * - health → 通道健康度
 *
 * 不变式（FR-M3-07）：
 * - EmergencyFrozen 广播后，所有节点在 ≤10s 内完成 JTI 吊销
 * - 单凭证吊销不广播（仅 revokeAll 触发广播）
 */
@Injectable()
export class FuseService {
  private readonly logger = new Logger(FuseService.name);

  constructor(
    @Inject(CREDENTIAL_JTI_REGISTRY) private readonly registry: CredentialJtiRegistry,
    @Inject(FUSE_CIRCUIT) private readonly fuse: FuseCircuitPort,
    private readonly events: EventEmitter2,
  ) {}

  /**
   * 紧急冻结 —— 广播风暴路径（FR-M3-07 ≤10s 全节点生效）。
   * 步骤：
   * 1. 收集 principal 下所有活跃 JTI
   * 2. 批量吊销
   * 3. 广播 EmergencyFrozen
   */
  async emergencyFreeze(principal: string): Promise<FuseBroadcast> {
    const jtis = await this.registry.listByPrincipal(principal);
    if (jtis.length === 0) {
      this.logger.warn(`emergencyFreeze: no active tokens for principal=${principal}`);
      return { principal, jtis: [], broadcastAt: new Date().toISOString() };
    }
    await Promise.all(jtis.map((jti) => this.registry.revoke(jti)));
    const broadcast = await this.fuse.broadcast(principal, jtis);
    // 同步发布领域事件供审计域消费
    this.events.emit('TokenRevoked', { principal, jtis, timestamp: broadcast.broadcastAt });
    this.logger.log(
      `emergencyFreeze completed: principal=${principal}, revoked=${jtis.length} tokens`,
    );
    return broadcast;
  }

  /** 单凭证吊销（不广播风暴） */
  async revoke(jti: string): Promise<void> {
    await this.registry.revoke(jti);
    this.events.emit('TokenRevoked', { jti, timestamp: new Date().toISOString() });
  }

  /** 健康检查 */
  async health(): Promise<{ healthy: boolean; broadcastHealthy: boolean }> {
    return {
      healthy: await this.fuse.healthy(),
      broadcastHealthy: await this.fuse.healthy(),
    };
  }

  /** 签发凭证（委托给 CredentialService，此处仅为便捷封装） */
  async issue(
    evidenceId: string,
    scope: CredentialScope,
    principal: string,
  ): Promise<IssuedCredential> {
    const ttl = Math.min(scope.ttl, 30 * 60);
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

  private encodeToken(claims: {
    jti: string;
    principal: string;
    evidenceId: string;
    scope: CredentialScope;
    expiresAt: string;
  }): string {
    const header = Buffer.from(JSON.stringify({ alg: 'EdDSA', typ: 'JWT' })).toString('base64url');
    const body = Buffer.from(JSON.stringify(claims)).toString('base64url');
    return `${header}.${body}.skeleton-signature`;
  }
}
