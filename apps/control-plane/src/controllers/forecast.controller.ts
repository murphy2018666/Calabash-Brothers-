import { Controller, Get, Query, Param, BadRequestException } from '@nestjs/common';
import { ForecastService, ForecastResult, HistoricalRevenuePoint } from '../services/forecast.service';

/**
 * 收入预测 API Controller（K16-2）。
 *
 * 端点：
 *   GET /api/forecast/revenue      — 收入预测
 *   GET /api/forecast/historical   — 历史收入时间序列
 */
@Controller('api/forecast')
export class ForecastController {
  constructor(private readonly forecastService: ForecastService) {}

  @Get('revenue')
  getRevenueForecast(
    @Query('tenantId') tenantId?: string,
    @Query('months') monthsParam?: string,
    @Query('method') method?: string,
  ): ForecastResult {
    const periodCount = monthsParam ? parseInt(monthsParam, 10) : 3;
    const forecastMethod = (method === 'exponential' ? 'exponential' : 'linear') as 'linear' | 'exponential';

    if (isNaN(periodCount) || periodCount < 1 || periodCount > 24) {
      throw new BadRequestException('months must be an integer between 1 and 24');
    }
    if (method && method !== 'linear' && method !== 'exponential') {
      throw new BadRequestException('method must be linear or exponential');
    }

    return this.forecastService.predict(tenantId, periodCount, forecastMethod);
  }

  @Get('historical')
  getHistoricalRevenue(
    @Query('tenantId') tenantId?: string,
    @Query('months') monthsParam?: string,
  ): HistoricalRevenuePoint[] {
    const months = monthsParam ? parseInt(monthsParam, 10) : 12;
    if (isNaN(months) || months < 1 || months > 24) {
      throw new BadRequestException('months must be an integer between 1 and 24');
    }
    return this.forecastService.getHistoricalRevenue(tenantId, months);
  }

  @Get('revenue/:skillId')
  getRevenueForecastBySkill(
    @Param('skillId') skillId: string,
    @Query('tenantId') tenantId?: string,
    @Query('months') monthsParam?: string,
    @Query('method') method?: string,
  ): ForecastResult {
    if (!tenantId) {
      throw new BadRequestException('tenantId is required for skill-level forecast');
    }
    const periodCount = monthsParam ? parseInt(monthsParam, 10) : 3;
    const forecastMethod = (method === 'exponential' ? 'exponential' : 'linear') as 'linear' | 'exponential';

    if (isNaN(periodCount) || periodCount < 1 || periodCount > 24) {
      throw new BadRequestException('months must be an integer between 1 and 24');
    }
    if (method && method !== 'linear' && method !== 'exponential') {
      throw new BadRequestException('method must be linear or exponential');
    }

    return this.forecastService.predictBySkill(tenantId, skillId, periodCount, forecastMethod);
  }
}
