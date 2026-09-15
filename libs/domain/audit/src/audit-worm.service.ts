import { createHash } from 'crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { AuditEnvelope } from '@aegisci/shared/types';

/**
 * WORM 审计写入槽 —— S3 Object Lock（Compliance 模式，Retention=7 年）。
 * 接口仅暴露 appendObject：无 update/delete 方法，从接口层保证追加只写语义。
 * 主存储不可关闭、不可替换为可删存储（DES-8 / AUDIT_SINK 不可关闭）。
 */
export const AUDIT_WORM_SINK = Symbol('AUDIT_WORM_SINK');

export interface AuditWormSink {
  /** 追加写单个对象（Object Lock 立即生效）。无更新/删除路径。 */
  appendObject(objectKey: string, canonicalBody: string): Promise<void>;
}

export interface AuditSealedResult {
  readonly objectKey: string;
  readonly sealed: true;
  readonly contentHash: string;
}

/**
 * Audit 子域 —— WORM 审计固化（DES-8）。
 *
 * 内核组件（不可关闭）：不提供 disable()/close() 方法 —— WORM 是合规底线。
 * 写入策略：追加分区 audit/{tenant}/{yyyy-mm-dd}/{envelopeId}.json，禁止覆盖写。
 * 不可变性由 S3 Object Lock Compliance 模式在存储层兜底；本服务只规范写入路径。
 */
@Injectable()
export class AuditWormService {
  private readonly logger = new Logger(AuditWormService.name);

  constructor(@Inject(AUDIT_WORM_SINK) private readonly sink: AuditWormSink) {}

  /** 固化一条审计信封 —— 追加写，无更新/删除。 */
  async seal(envelope: AuditEnvelope): Promise<AuditSealedResult> {
    const objectKey = this.objectKey(envelope);
    const body = JSON.stringify(envelope);
    const contentHash = createHash('sha256').update(body).digest('hex');
    await this.sink.appendObject(objectKey, body);
    this.logger.debug(`sealed audit envelope ${envelope.envelopeId} → ${objectKey}`);
    return { objectKey, sealed: true, contentHash };
  }

  private objectKey(envelope: AuditEnvelope): string {
    const day = envelope.timestamp.slice(0, 10); // yyyy-mm-dd
    return `audit/${envelope.tenantId}/${day}/${envelope.envelopeId}.json`;
  }
}
