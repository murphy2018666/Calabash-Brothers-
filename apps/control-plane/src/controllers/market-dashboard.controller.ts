import { Controller, Get, Query } from '@nestjs/common';
import { MarketDashboardService } from '../services/market-dashboard.service';
import { type RevenueSummary, type WarningMetrics, type CertificationStats } from '../services/market-dashboard.service';

/**
 * 市场运营仪表板控制器（K14/K15）。
 *
 * 端点：
 *   GET /api/dashboard/composite  — 完整仪表板
 *   GET /api/dashboard/health     — 健康度评分
 *   GET /api/dashboard/revenue    — 收入汇总
 *   GET /api/dashboard/warnings   — 预警统计
 *   GET /api/dashboard/certifications — 认证统计
 *   GET /api/dashboard/tenant/:id — 单租户概要（K15-4）
 *   GET /api/dashboard/platform   — 全平台汇总（K15-4）
 */
@Controller('api/dashboard')
export class MarketDashboardController {
  constructor(private readonly dashboard: MarketDashboardService) {}

  @Get('composite')
  getComposite(@Query('tenantId') tenantId: string) {
    return this.dashboard.getCompositeDashboard(tenantId);
  }

  @Get('health')
  getHealth(@Query('tenantId') tenantId: string) {
    return this.dashboard.getHealthScore(tenantId);
  }

  @Get('revenue')
  getRevenue(
    @Query('tenantId') tenantId: string,
    @Query('period') period?: string,
  ) {
    return this.dashboard.getRevenueSummary(tenantId, period);
  }

  @Get('warnings')
  getWarnings(@Query('tenantId') tenantId: string) {
    return this.dashboard.getWarningStats(tenantId);
  }

  @Get('certifications')
  getCertifications(@Query('tenantId') tenantId: string) {
    return this.dashboard.getCertificationStats(tenantId);
  }

  /** K15-4：单租户概要 */
  @Get('tenant/:tenantId')
  getTenantSummary(@Query('tenantId') tenantId: string) {
    return this.dashboard.getTenantSummary(tenantId);
  }

  /** K15-4：全平台汇总 */
  @Get('platform')
  getPlatformOverview() {
    return this.dashboard.getPlatformOverview();
  }

  /** K20-4：续约提醒 */
  @Get('renewals')
  getRenewals(
    @Query('tenantId') tenantId: string,
    @Query('hoursAhead') hoursAhead?: string,
  ): AutoRenewalConfig[] {
    const hours = hoursAhead ? parseInt(hoursAhead, 10) : 24;
    return this.dashboard.getRenewalReminders(tenantId, hours);
  }
}
