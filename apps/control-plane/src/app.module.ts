import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { AuditModule } from '@aegisci/domain/audit';
import { PipelineModule } from '@aegisci/domain/pipeline';
import { OrchestrationModule } from '@aegisci/domain/orchestration';
import { PolicyDecisionModule } from '@aegisci/domain/policy/decision';
import { ApprovalModule } from '@aegisci/domain/policy/approval';
import { CredentialModule } from '@aegisci/domain/policy/credential';
import { IdentityModule } from '@aegisci/domain/identity';
import { SkillModule } from '@aegisci/domain/skill';

import { SpiDefaultsModule } from './providers/spi-defaults.module';
import { HealthController } from './controllers/health.controller';
import { WebhookController } from './controllers/webhook.controller';
import { GateController } from './controllers/gate.controller';
import { SkillMarketController } from './controllers/skill-market.controller';
import { BillingController } from './controllers/billing.controller';
import { ToolCallAuthorizeGuard } from './guards/tool-call-authorize.guard';
import { AgentActionAuditGuard } from './guards/agent-action-audit.guard';
import { BlackboardCommunicationGuard } from './guards/blackboard-communication.guard';
import { MeteringAuditGuard } from './guards/metering-audit.guard';
import { AuthGuard } from './guards/auth.guard';
import { OrchestratorBridgeService } from './providers/orchestrator-bridge.service';
import { BillingEngineService } from './services/billing-engine.service';
import { MeteringCollectorService } from './services/metering-collector.service';
import { BillingService } from './services/billing-service';
import { SplitEngineService } from './services/split-engine.service';
import { SettlementService } from './services/settlement-service';
import { SettlementController } from './controllers/settlement.controller';
import { CertificationEngineService } from './services/certification-engine.service';
import { CertificationMarkService } from './services/certification-mark.service';
import { RefundService } from './services/refund-service';
import { CertificationController } from './controllers/certification.controller';
import { SkillRatingService } from './services/skill-rating.service';
import { DelistWarningService } from './services/delist-warning.service';
import { SkillRatingController } from './controllers/skill-rating.controller';
import { MarketDashboardService } from './services/market-dashboard.service';
import { MarketDashboardController } from './controllers/market-dashboard.controller';
import { PricingModelService } from './services/pricing-model.service';
import { CommissionRateService } from './services/commission-rate.service';
import { ReconciliationService } from './services/reconciliation.service';
import { ForecastService } from './services/forecast.service';
import { ForecastController } from './controllers/forecast.controller';
import { DelistWorkflowService } from './services/delist-workflow.service';
import { ReconciliationController } from './controllers/reconciliation.controller';
import { CertifiedSkillPricingService } from './services/certified-skill-pricing.service';
import { CertifiedSkillPricingController } from './controllers/certified-skill-pricing.controller';
import { PolicyPackExclusiveService } from './services/policy-pack-exclusive.service';
import { PolicyPackExclusiveController } from './controllers/policy-pack-exclusive.controller';
import { MeteringService } from './services/metering.service';
import { MeteringController } from './controllers/metering.controller';

/**
 * AppModule —— 控制面根模块（ADD §2 模块化单体）。
 *
 * 装配所有领域模块 + SPI 默认实现（SpiDefaultsModule 全局提供）：
 * PL / OR / PolicyDecision / PolicyApproval / PolicyCredential / Identity / Audit / Skill。
 *
 * 内核不变量守卫（3 条，ADD §4 / FR-M7-01）作为可注入 Provider 注册，
 * 在工具调用 / Agent 动作 / 黑板通信路径上强制不变量。
 */
@Module({
  imports: [
    EventEmitterModule.forRoot(),
    SpiDefaultsModule,
    AuditModule,
    PipelineModule,
    OrchestrationModule,
    PolicyDecisionModule,
    ApprovalModule,
    CredentialModule,
    IdentityModule,
    SkillModule,
  ],
  controllers: [HealthController, WebhookController, GateController, SkillMarketController, BillingController, SettlementController, CertificationController, SkillRatingController, MarketDashboardController, ForecastController, ReconciliationController],
  providers: [
    ToolCallAuthorizeGuard,
    AgentActionAuditGuard,
    BlackboardCommunicationGuard,
    MeteringAuditGuard,
    // S2 F1-4：统一鉴权守卫（路由级 @UseGuards(AuthGuard) 使用；
    // 不设为全局 APP_GUARD —— webhook 采用 actor 身份模型而非 Bearer token）。
    AuthGuard,
    // D2-1: OR↔PL 事件桥接服务（需 AgentDispatcherService，放在根模块）
    OrchestratorBridgeService,
    // K10: 计量计费引擎
    BillingEngineService,
    MeteringCollectorService,
    BillingService,
    // K11: 分账结算
    SplitEngineService,
    SettlementService,
    // K12: 官方认证体系
    CertificationEngineService,
    CertificationMarkService,
    RefundService,
    // K13: 技能市场质量治理
    SkillRatingService,
    DelistWarningService,
    // K14: 市场运营仪表板
    MarketDashboardService,
    // K16: 收入预测
    ForecastService,
    // K17: 自动下架工作流
    DelistWorkflowService,
    // K18: 认证付费技能 + 独占 Policy Pack + 计量服务
    CertifiedSkillPricingService,
    PolicyPackExclusiveService,
    MeteringService,
    // K20: 自动续约 + 认证计费钩子 + 对账闭环
    AutoRenewalService,
    CertificationBillingHookService,
    ReconciliationBridgeService,
  ],
})
export class AppModule {}
