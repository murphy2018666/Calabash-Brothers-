import { Test, TestingModule } from '@nestjs/testing';
import { SplitEngineService } from '../services/split-engine.service';
import { SettlementService } from '../services/settlement-service';
import { SettlementController } from './settlement.controller';
import { type MonthlyBill } from '@aegisci/shared/types';

describe('SettlementController (K11)', () => {
  let controller: SettlementController;
  let settlementService: SettlementService;
  let splitEngine: SplitEngineService;

  const makeBill = (tenantId: string, period: string, subtotal: number): MonthlyBill => ({
    billId: `bill_${period}_${tenantId}`,
    tenantId,
    period,
    totalCalls: 1,
    totalCost: subtotal,
    lineItems: [{ skillId: 'skill-1', name: 'A', calls: 1, unitPrice: subtotal, subtotal }],
    status: 'draft',
    createdAt: new Date().toISOString(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [SettlementController],
      providers: [SettlementService, SplitEngineService],
    }).compile();
    controller = module.get<SettlementController>(SettlementController);
    settlementService = module.get<SettlementService>(SettlementService);
    splitEngine = module.get<SplitEngineService>(SplitEngineService);
  });

  afterEach(() => {
    settlementService.clear();
    splitEngine.clear();
  });

  describe('GET /api/settlements', () => {
    it('returns empty list when no settlements', () => {
      const result = controller.listSettlements({ tenantId: 'tenant-1', page: 1, pageSize: 10 });
      expect(result.settlements).toHaveLength(0);
      expect(result.total).toBe(0);
    });
  });

  describe('POST /api/settlements/generate', () => {
    it('generates settlement from bill', () => {
      const bill = makeBill('tenant-1', '2026-01', 100);
      const result = controller.generateSettlement({ bill });
      expect(result.tenantId).toBe('tenant-1');
      expect(result.period).toBe('2026-01');
      expect(result.status).toBe('pending');
    });
  });

  describe('POST /api/settlements/:id/approve', () => {
    it('approves a pending settlement above threshold', () => {
      const bill = makeBill('tenant-1', '2026-01', 200);
      const settlement = controller.generateSettlement({ bill });
      const result = controller.approveSettlement(settlement.settlementId);
      expect(result.status).toBe('approved');
    });
  });

  describe('POST /api/settlements/:id/pay', () => {
    it('pays an approved settlement', () => {
      const bill = makeBill('tenant-1', '2026-01', 200);
      const settlement = controller.generateSettlement({ bill });
      controller.approveSettlement(settlement.settlementId);
      const result = controller.paySettlement(settlement.settlementId);
      expect(result.status).toBe('paid');
    });
  });

  describe('GET /api/settlements/:id/export', () => {
    it('returns CSV export', () => {
      const bill = makeBill('tenant-1', '2026-01', 200);
      const settlement = controller.generateSettlement({ bill });
      const csv = controller.exportSettlement(settlement.settlementId);
      expect(csv).toContain('settlement_id');
      expect(csv).toContain('skill-1');
    });
  });

  describe('GET /api/settlements/stats', () => {
    it('returns zero stats when no settlements', () => {
      const stats = controller.getStats({ tenantId: 'tenant-1' });
      expect(stats.totalRevenue).toBe(0);
      expect(stats.totalPayout).toBe(0);
    });
  });

  describe('GET /api/settlements/split-models', () => {
    it('returns default ratios', () => {
      const result = controller.getSplitModels('tenant-1');
      expect(result.ratios).toContain('standard');
      expect(result.ratios).toContain('certified');
    });

    it('returns default model for skill', () => {
      const result = controller.getSplitModels('tenant-1', 'skill-1');
      // default model should have ratio
      expect(typeof result).toBe('object');
      expect(result.skillOwnerPct).toBe(80);
      expect(result.platformPct).toBe(20);
    });
  });
});
