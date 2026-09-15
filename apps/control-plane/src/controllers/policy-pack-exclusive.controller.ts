import { Controller, Get, Post, Param, Body } from '@nestjs/common';
import { PolicyPackExclusiveService, ExclusivePack } from '../services/policy-pack-exclusive.service';

@Controller('policy-packs')
export class PolicyPackExclusiveController {
  constructor(private readonly service: PolicyPackExclusiveService) {}

  @Post('exclusive')
  createExclusivePack(@Body() body: { tenantId: string; packName: string; policies: string[] }): ExclusivePack {
    return this.service.createExclusivePack(body.tenantId, body.packName, body.policies);
  }

  @Post('exclusive/:id/publish')
  publishPack(@Param('id') packId: string): ExclusivePack {
    return this.service.publishPack(packId);
  }

  @Get('exclusive')
  getAvailablePacks(@Query('tenantId') tenantId: string): ExclusivePack[] {
    return this.service.getAvailablePacks(tenantId);
  }

  @Post('exclusive/:id/grant')
  grantAccess(@Param('id') packId: string, @Body() body: { targetTenantId: string }): boolean {
    return this.service.grantAccess(packId, body.targetTenantId);
  }

  @Post('exclusive/:id/revoke')
  revokeAccess(@Param('id') packId: string, @Body() body: { targetTenantId: string }): boolean {
    return this.service.revokeAccess(packId, body.targetTenantId);
  }
}
