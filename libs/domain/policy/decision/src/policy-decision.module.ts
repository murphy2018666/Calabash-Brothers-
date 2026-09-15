import { Module } from '@nestjs/common';
import { PolicyDecisionService } from './policy-decision.service';

/**
 * Policy Decision 子域 NestJS 模块（DES-5.0 热路径）。
 * PolicyEngineSPI 与 PolicyDecisionCache 的实现由控制面在组装时注入，
 * 本模块只声明并导出裁决同步入口。
 */
@Module({
  providers: [PolicyDecisionService],
  exports: [PolicyDecisionService],
})
export class PolicyDecisionModule {}
