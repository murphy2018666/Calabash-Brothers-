/**
 * OrchestrationModule —— OR 域 NestJS 模块
 *
 * 对应设计文档：
 * - DES-3 DDD 上下文 / DES-13 可插拔架构
 * - ADD §5.2 Orchestration 状态机
 *
 * 模块边界：
 * - 暴露 OR 域的应用服务（AgentDispatcherService / BlackboardService）。
 * - 通过 DI 令牌注入 SPI（AgentProvider）与端口实现（仓储/事件发布器），
 *   实现可替换、控制点在内核（FR-M7-08）。
 * - 不持有 Run/Gate 状态；与 PL 域仅通过领域事件耦合。
 *
 * 使用方需在根模块导入 EventEmitterModule（@nestjs/event-emitter）以启用事件发布。
 */
import { Module } from '@nestjs/common';
import { BlackboardService } from './services/blackboard.service';
import { AgentDispatcherService } from './services/agent-dispatcher';

@Module({
  providers: [
    BlackboardService,
    AgentDispatcherService,
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
    // 端口令牌由控制面 SpiDefaultsModule（@Global）注入：
    // - SPI_TOKENS.AGENT_PROVIDER → InMemoryAgentProvider
    // - BLACKBOARD_REPOSITORY → InMemoryBlackboardRepository
    // - OR_EVENT_PUBLISHER → EventEmitter2Adapter
    // - TASK_PLAN_REPOSITORY → InMemoryTaskPlanRepository
    // 本模块不绑定默认实现，保证可插拔与单测可替换（DES-13 / FR-M7-02）
    // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  ],
  exports: [
    BlackboardService,
    AgentDispatcherService,
  ],
})
export class OrchestrationModule {}
