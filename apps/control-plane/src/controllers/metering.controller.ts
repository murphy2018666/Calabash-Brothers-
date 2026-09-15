import { Controller, Get, Post, Body, Query } from '@nestjs/common';
import { MeteringService, UsageEvent } from '../services/metering.service';

@Controller('metering')
export class MeteringController {
  constructor(private readonly meteringService: MeteringService) {}

  @Post('record')
  recordUsage(@Body() body: { eventType: string; tenantId: string; skillId: string; metadata?: Record<string, unknown> }): UsageEvent {
    return this.meteringService.recordUsage(body.eventType, body.tenantId, body.skillId, body.metadata);
  }

  @Post('batch')
  batchRecord(@Body() events: Array<{ eventType: string; tenantId: string; skillId: string; metadata?: Record<string, unknown> }>): void {
    this.meteringService.batchRecord(events);
  }

  @Get('query')
  queryUsage(
    @Query('tenantId') tenantId: string,
    @Query('skillId') skillId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): UsageEvent[] {
    return this.meteringService.queryUsage(tenantId, skillId, from, to);
  }

  @Get('stats/:tenantId')
  getStats(@Param('tenantId') tenantId: string) {
    return this.meteringService.getStats(tenantId);
  }
}
