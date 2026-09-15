import { Module } from '@nestjs/common';
import { CredentialService } from './credential.service';

/**
 * Policy Credential 子域 NestJS 模块（DES-5.3 风暴路径）。
 * CredentialJtiRegistry 实现由控制面注入；通过 EventEmitter2 消费
 * ApprovalCompleted（签发）与 SkillRevoked（级联回收）。
 */
@Module({
  providers: [CredentialService],
  exports: [CredentialService],
})
export class CredentialModule {}
