import { Controller, Get, Post, Param, Body, Query, BadRequestException } from '@nestjs/common';
import {
  type MonthlyBill,
  type SettlementResponse,
  type SettlementStats,
} from '@aegisci/shared/types';
import { SettlementService } from '../services/settlement-service';
import { SplitEngineService } from '../services/split-engine.service';

/**
 * 结算 API Controller（K11）。
 *
 * 8 个端点：
 * - GET    /api/settlements              分页查询
 * - GET    /api/settlements/:settlementId 详情
 * - POST   /api/settlements/generate      手动生成
 * - POST   /api/settlements/:settlementId/approve 审批
 * - POST   /api/settlements/:settlementId/pay 支付
 * - GET    /api/settlements/:settlementId/export 导出 CSV
 * - GET    /api/settlements/stats         统计摘要
 * - GET    /api/settlements/split-models  分账模型列表
 */
@Controller('api/settlements')
export class SettlementController {
  constructor(
    private readonly settlementService: SettlementService,
    private readonly splitEngine: SplitEngineService,
  ) {}

  // ── 列表/详情 ──

  @Get()
  listSettlements(
    @Query('tenantId') tenantId: string,
    @Query('period') period?: string,
    @Query('status') status?: string,
    @Query('page') page?: number,
    @Query('pageSize') pageSize?: number,
  ): SettlementResponse {
    const result = this.settlementService.listSettlements({
      tenantId,
      period,
      status: status as any,
      page,
      pageSize,
    });
    return result;
  }

  @Get(':settlementId')
  getSettlement(@Param('settlementId') settlementId: string): any {
    return this.settlementService.getSettlement(settlementId);
  }

  // ── 生成 ──

  @Post('generate')
  generateSettlement(@Body() body: { bill: MonthlyBill }): any {
    if (!body.bill) {
      throw new BadRequestException('bill is required');
    }
    return this.settlementService.generateSettlement(body.bill);
  }

  // ── 状态流转 ──

  @Post(':settlementId/approve')
  approveSettlement(@Param('settlementId') settlementId: string): any {
    return this.settlementService.approveSettlement(settlementId);
  }

  @Post(':settlementId/pay')
  paySettlement(@Param('settlementId') settlementId: string): any {
    return this.settlementService.paySettlement(settlementId);
  }

  // ── 导出 ──

  @Get(':settlementId/export')
  exportSettlement(@Param('settlementId') settlementId: string): string {
    const settlement = this.settlementService.getSettlement(settlementId);
    return this.settlementService.exportSettlementCsv(settlement);
  }

  // ── 统计/配置 ──

  @Get('stats')
  getStats(@Query('tenantId') tenantId: string): SettlementStats {
    return this.settlementService.getStats(tenantId);
  }

  @Get('split-models')
  getSplitModels(@Query('tenantId') tenantId: string, @Query('skillId') skillId?: string): any {
    if (skillId) {
      return this.splitEngine.getSplitModel(tenantId, skillId);
    }
    return { ratios: this.splitEngine.getAvailableRatios() };
  }
}
