import { Module } from '@nestjs/common';
import { AuditWormService } from './audit-worm.service';

/**
 * Audit 子域 NestJS 模块（DES-8）。
 * 内核组件（不可关闭）；AuditWormSink 实现由控制面注入（S3/MinIO Object Lock）。
 */
@Module({
  providers: [AuditWormService],
  exports: [AuditWormService],
})
export class AuditModule {}
