import { Controller, Get, Post, Put, Delete, Body, Param, Query } from '@nestjs/common';
import { CertifiedSkillPricingService, PricingPlan } from '../services/certified-skill-pricing.service';

@Controller('certified-skills')
export class CertifiedSkillPricingController {
  constructor(private readonly pricingService: CertifiedSkillPricingService) {}

  @Post('pricing')
  createPricingPlan(
    @Body() body: { skillId: string; tenantId: string; period: 'monthly' | 'yearly' | 'perpetual'; price: number },
  ): PricingPlan {
    return this.pricingService.createPricingPlan(body.skillId, body.tenantId, body.period, body.price);
  }

  @Get('pricing/:skillId')
  getPricingPlan(@Param('skillId') skillId: string, @Query('tenantId') tenantId: string): PricingPlan | null {
    const plan = this.pricingService.getPricingPlan(skillId, tenantId);
    return plan ?? null;
  }

  @Put('pricing/:planId')
  updatePricingPlan(
    @Param('planId') planId: string,
    @Body() updates: Partial<PricingPlan>,
  ): PricingPlan | null {
    return this.pricingService.updatePricingPlan(planId, updates);
  }

  @Delete('pricing/:planId')
  deletePricingPlan(@Param('planId') planId: string, @Query('tenantId') tenantId: string): boolean {
    return this.pricingService.deletePricingPlan(planId, tenantId);
  }

  @Get('pricing')
  listPricingPlans(@Query('tenantId') tenantId: string): PricingPlan[] {
    return this.pricingService.listPricingPlans(tenantId);
  }
}
