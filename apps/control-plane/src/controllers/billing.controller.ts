import {
  Controller,
  Get,
  Post,
  Query,
  Param,
  Injectable,
  Logger,
} from '@nestjs/common';
import { BillingService } from '../services/billing-service';
import { MeteringCollectorService } from '../services/metering-collector.service';
import { MonthlyBill, MeteringResponse, BillingStats } from '@aegisci/shared/types';

/**
 * 计量计费 API Controller（K10-3）。
 *
 * 端点：
 * - GET /api/billing/metering    — 查询计量记录
 * - GET /api/billing/bills       — 列出账单（按月份）
 * - POST /api/billing/bills/generate — 生成月度账单
 * - GET /api/billing/bills/:billId  — 账单详情
 * - GET /api/billing/bills/:billId/export — 导出账单
 * - GET /api/billing/pricing-tiers — 定价档位列表
 * - GET /api/billing/stats       — 计量统计
 */
@Controller('api/billing')
export class BillingController {
  private readonly logger = new Logger(BillingController.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly collector: MeteringCollectorService,
  ) {}

  /** 查询计量记录 */
  @Get('metering')
  getMetering(
    @Query('tenantId') tenantId: string,
    @Query('skillId') skillId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ): MeteringResponse {
    return this.billingService.getMetering(
      tenantId,
      skillId,
      from,
      to,
      parseInt(page ?? '1'),
      parseInt(pageSize ?? '50'),
    );
  }

  /** 列出账单（返回最近 N 个月） */
  @Get('bills')
  listBills(
    @Query('tenantId') tenantId: string,
    @Query('limit') limit?: string,
  ): MonthlyBill[] {
    const count = parseInt(limit ?? '12');
    const bills: MonthlyBill[] = [];
    const now = new Date();
    for (let i = 0; i < count; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      bills.push(this.billingService.generateBill(tenantId, period));
    }
    return bills;
  }

  /** 手动生成月度账单 */
  @Post('bills/generate')
  generateBill(
    @Query('tenantId') tenantId: string,
    @Query('period') period: string,
  ): MonthlyBill {
    return this.billingService.generateBill(tenantId, period);
  }

  /** 获取账单详情 */
  @Get('bills/:billId')
  getBill(@Param('billId') billId: string, @Query('tenantId') tenantId: string): MonthlyBill {
    // stub: 根据 billId 和 tenantId 定位月份
    const period = billId.replace('bill_', '').replace(`_${tenantId}`, '');
    return this.billingService.generateBill(tenantId, period);
  }

  /** 导出账单 CSV */
  @Get('bills/:billId/export')
  exportBill(
    @Param('billId') billId: string,
    @Query('tenantId') tenantId: string,
    @Query('format') format?: string,
  ): string {
    const period = billId.replace('bill_', '').replace(`_${tenantId}`, '');
    const bill = this.billingService.generateBill(tenantId, period);
    return format === 'json' ? this.billingService.exportBillJson(bill) : this.billingService.exportBillCsv(bill);
  }

  /** 获取可用定价档位 */
  @Get('pricing-tiers')
  pricingTiers() {
    return this.billingService.getPricingTiers();
  }

  /** 计量统计摘要 */
  @Get('stats')
  stats(@Query('tenantId') tenantId: string) {
    const base = this.billingService.getStats(tenantId);
    const topSkills = this.billingService.getTopSkills(tenantId);
    return { ...base, topSkills };
  }
}
