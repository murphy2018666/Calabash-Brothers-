import { Module } from '@nestjs/common';
import { ApprovalService } from './approval.service';

/**
 * Policy Approval 子域 NestJS 模块（DES-5.0 冷路径）。
 * 不持有出站通道；ApprovalCompleted 经 EventEmitter2 发布，由 Credential 子域消费。
 */
@Module({
  providers: [ApprovalService],
  exports: [ApprovalService],
})
export class ApprovalModule {}
