import { Test, TestingModule } from '@nestjs/testing';
import { SplitEngineService } from './split-engine.service';
import { SettlementService } from './settlement-service';
import { type MonthlyBill } from '@aegisci/shared/types';

describe('SettlementService (K11)', () => {
  let service: SettlementService;
  let splitEngine: SplitEngineService;

  const makeBill = (tenantId: string, period: string, items: { skillId: string; name: string; calls: number; unitPrice: number; subtotal: number }[]): MonthlyBill => ({
    billId: `bill_${period}_${tenantId}`,
    tenantId,
    period,
    totalCalls: items.reduce((s, i) => s + i.calls, 0),
    totalCost: items.reduce((s, i) => s + i.subtotal, 0),
    lineItems: items,
    status: 'draft',
    createdAt: new Date().toISOString(),
  });

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SettlementService, SplitEngineService],
    }).compile();
    service = module.get<SettlementService>(SettlementService);
    splitEngine = module.get<SplitEngineService>(SplitEngineService);
  });

  afterEach(() => {
    service.clear();
    splitEngine.clear();
  });

  describe('generateSettlement', () => {
    it('generates settlement from MonthlyBill with standard split', () => {
      const bill = makeBill('tenant-1', '2026-01', [
        { skillId: 'skill-1', name: 'Skill A', calls: 10, unitPrice: 5, subtotal: 50 },
      ]);
      const settlement = service.generateSettlement(bill);
      expect(settlement.tenantId).toBe('tenant-1');
      expect(settlement.period).toBe('2026-01');
      expect(settlement.status).toBe('pending');
      expect(settlement.splitRecords).toHaveLength(1);
      expect(settlement.splitRecords[0].skillId).toBe('skill-1');
      // standard 80/20
      expect(settlement.totalSkillOwnerPayout).toBe(40);
      expect(settlement.totalPlatformRevenue).toBe(10);
    });

    it('generates settlement with certified split (90/10)', () => {
      splitEngine.setSplitModel('tenant-1', 'skill-cert', {
        ratio: 'certified', skillOwnerPct: 90, platformPct: 10,
      });
      const bill = makeBill('tenant-1', '2026-02', [
        { skillId: 'skill-cert', name: 'Cert Skill', calls: 5, unitPrice: 10, subtotal: 50 },
      ]);
      const settlement = service.generateSettlement(bill);
      expect(settlement.totalSkillOwnerPayout).toBe(45);
      expect(settlement.totalPlatformRevenue).toBe(5);
    });

    it('sums multiple line items correctly', () => {
      const bill = makeBill('tenant-1', '2026-03', [
        { skillId: 'skill-1', name: 'A', calls: 10, unitPrice: 5, subtotal: 50 },
        { skillId: 'skill-2', name: 'B', calls: 20, unitPrice: 3, subtotal: 60 },
      ]);
      const settlement = service.generateSettlement(bill);
      expect(settlement.totalRevenue).toBe(110);
      expect(settlement.totalSkillOwnerPayout).toBe(88); // 110 * 0.8
      expect(settlement.totalPlatformRevenue).toBe(22);
    });
  });

  describe('approveSettlement', () => {
    it('approves pending settlement above threshold', () => {
      const bill = makeBill('tenant-1', '2026-01', [
        { skillId: 'skill-1', name: 'A', calls: 100, unitPrice: 2, subtotal: 200 },
      ]);
      const settlement = service.generateSettlement(bill);
      const approved = service.approveSettlement(settlement.settlementId);
      expect(approved.status).toBe('approved');
      expect(approved.approvedAt).toBeDefined();
    });

    it('rejects approval for below-threshold payout', () => {
      // payout = 10 < 100 threshold
      const bill = makeBill('tenant-1', '2026-01', [
        { skillId: 'skill-1', name: 'A', calls: 10, unitPrice: 1, subtotal: 10 },
      ]);
      const settlement = service.generateSettlement(bill);
      expect(() => service.approveSettlement(settlement.settlementId))
        .toThrow('below minimum threshold');
    });

    it('rejects approval of already-approved settlement', () => {
      const bill = makeBill('tenant-1', '2026-01', [
        { skillId: 'skill-1', name: 'A', calls: 100, unitPrice: 2, subtotal: 200 },
      ]);
      const settlement = service.generateSettlement(bill);
      service.approveSettlement(settlement.settlementId);
      expect(() => service.approveSettlement(settlement.settlementId))
        .toThrow("status 'approved'");
    });

    it('rejects non-existent settlement', () => {
      expect(() => service.approveSettlement('non-existent')).toThrow('not found');
    });
  });

  describe('paySettlement', () => {
    it('pays approved settlement', () => {
      const bill = makeBill('tenant-1', '2026-01', [
        { skillId: 'skill-1', name: 'A', calls: 100, unitPrice: 2, subtotal: 200 },
      ]);
      const settlement = service.generateSettlement(bill);
      service.approveSettlement(settlement.settlementId);
      const paid = service.paySettlement(settlement.settlementId);
      expect(paid.status).toBe('paid');
      expect(paid.paidAt).toBeDefined();
    });

    it('rejects pay of non-approved settlement', () => {
      const bill = makeBill('tenant-1', '2026-01', [
        { skillId: 'skill-1', name: 'A', calls: 100, unitPrice: 1, subtotal: 100 },
      ]);
      const settlement = service.generateSettlement(bill);
      expect(() => service.paySettlement(settlement.settlementId))
        .toThrow("status 'pending'");
    });
  });

  describe('listSettlements', () => {
    it('returns settlements with pagination', () => {
      const bill1 = makeBill('tenant-1', '2026-01', [{ skillId: 's1', name: 'A', calls: 100, unitPrice: 1, subtotal: 100 }]);
      const bill2 = makeBill('tenant-1', '2026-02', [{ skillId: 's1', name: 'A', calls: 100, unitPrice: 1, subtotal: 100 }]);
      service.generateSettlement(bill1);
      service.generateSettlement(bill2);
      const result = service.listSettlements({ tenantId: 'tenant-1', page: 1, pageSize: 1 });
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(1);
      expect(result.settlements).toHaveLength(1);
    });

    it('filters by period', () => {
      const bill1 = makeBill('tenant-1', '2026-01', [{ skillId: 's1', name: 'A', calls: 100, unitPrice: 1, subtotal: 100 }]);
      const bill2 = makeBill('tenant-1', '2026-02', [{ skillId: 's1', name: 'A', calls: 100, unitPrice: 1, subtotal: 100 }]);
      service.generateSettlement(bill1);
      service.generateSettlement(bill2);
      const result = service.listSettlements({ tenantId: 'tenant-1', period: '2026-01' });
      expect(result.total).toBe(1);
      expect(result.settlements[0].period).toBe('2026-01');
    });
  });

  describe('exportSettlementCsv', () => {
    it('exports CSV with correct format', () => {
      const bill = makeBill('tenant-1', '2026-01', [
        { skillId: 'skill-1', name: 'A', calls: 100, unitPrice: 1, subtotal: 100 },
      ]);
      const settlement = service.generateSettlement(bill);
      const csv = service.exportSettlementCsv(settlement);
      const lines = csv.split('\n');
      expect(lines[0]).toContain('settlement_id');
      expect(lines[0]).toContain('total_revenue');
      expect(lines[3]).toContain('skill_id');
      expect(lines[4]).toContain('skill-1');
      expect(lines[4]).toContain('100');
      expect(lines[4]).toContain('standard');
    });
  });

  describe('getStats', () => {
    it('returns correct stats summary', () => {
      const bill1 = makeBill('tenant-1', '2026-01', [
        { skillId: 's1', name: 'A', calls: 100, unitPrice: 2, subtotal: 200 },
      ]);
      const bill2 = makeBill('tenant-1', '2026-02', [
        { skillId: 's1', name: 'A', calls: 100, unitPrice: 2, subtotal: 200 },
      ]);
      const s1 = service.generateSettlement(bill1);
      const s2 = service.generateSettlement(bill2);
      service.approveSettlement(s1.settlementId);
      service.approveSettlement(s2.settlementId);
      service.paySettlement(s2.settlementId);

      const stats = service.getStats('tenant-1');
      expect(stats.totalRevenue).toBe(400);
      expect(stats.pendingCount).toBe(0);
      expect(stats.approvedCount).toBe(1); // s1 approved, s2 paid
      expect(stats.paidCount).toBe(1);
    });
  });
});
