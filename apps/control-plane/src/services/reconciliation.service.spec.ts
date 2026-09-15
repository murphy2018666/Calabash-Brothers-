import { ReconciliationService, type Discrepancy } from './reconciliation.service';
import { type Settlement, type SplitRecord } from '@aegisci/shared/types';

describe('ReconciliationService (K15-3)', () => {
  let service: ReconciliationService;

  beforeEach(() => {
    service = new ReconciliationService();
  });

  afterEach(() => {
    service.clear();
  });

  // ── helper: build a valid Settlement mock ──
  function mkSettlement(overrides: Partial<Settlement> = {}): Settlement {
    return {
      settlementId: 's-1',
      tenantId: 't1',
      period: '2026-01',
      totalRevenue: 100,
      totalSkillOwnerPayout: 80,
      totalPlatformRevenue: 20,
      splitRecords: [
        {
          recordId: 'sr-1',
          billId: 'bill-1',
          tenantId: 't1',
          skillId: 'skill-a',
          revenue: 100,
          splitRatio: 'standard',
          skillOwnerAmount: 80,
          platformAmount: 20,
          createdAt: '2026-02-01T00:00:00Z',
        },
      ],
      status: 'completed',
      createdAt: '2026-02-01T00:00:00Z',
      ...overrides,
    };
  }

  describe('detectDiscrepancies', () => {
    it('returns no discrepancies when metering matches settlement cost and calls', () => {
      // settlement splitRecords has 1 record with skillOwnerAmount=80
      // meteringCalls=1 (matches splitRecords.length) and totalCost=80 (matches sum)
      const settlements: Settlement[] = [mkSettlement({ period: '2026-01' })];
      const result1 = service.detectDiscrepancies('t1', '2026-01', 1, 80, settlements);
      expect(result1).toHaveLength(0);
    });

    it('detects cost discrepancy above critical threshold (5%)', () => {
      const settlements: Settlement[] = [mkSettlement({ period: '2026-01' })];
      const result2 = service.detectDiscrepancies('t1', '2026-01', 1, 100, settlements);
      expect(result2).toHaveLength(1);
      expect(result2[0].severity).toBe('critical');
      expect(result2[0].type).toBe('cost');
    });

    it('flags discrepancy as warning when between 1% and 5%', () => {
      const closeSettlement: Settlement = {
        ...mkSettlement(),
        splitRecords: [
          {
            recordId: 'sr-1',
            billId: 'bill-1',
            tenantId: 't1',
            skillId: 'skill-a',
            revenue: 100,
            splitRatio: 'standard',
            skillOwnerAmount: 98,
            platformAmount: 2,
            createdAt: '2026-02-01T00:00:00Z',
          },
        ],
      };
      // meteringCalls=1 matches splitRecords.length=1
      const result3 = service.detectDiscrepancies('t1', '2026-01', 1, 100, [closeSettlement]);
      expect(result3).toHaveLength(1);
      expect(result3[0].severity).toBe('warning');
    });

    it('returns empty array when no settlements exist', () => {
      const result4 = service.detectDiscrepancies('t1', '2026-01', 10, 100, []);
      expect(result4).toHaveLength(0);
    });

    it('skips settlements with different period', () => {
      const settlements: Settlement[] = [mkSettlement({ period: '2026-02' })];
      const result5 = service.detectDiscrepancies('t1', '2026-01', 10, 100, settlements);
      expect(result5).toHaveLength(0);
    });
  });

  describe('listDiscrepancies', () => {
    it('stores and retrieves discrepancies', () => {
      const settlements: Settlement[] = [mkSettlement({ period: '2026-01' })];
      service.detectDiscrepancies('t1', '2026-01', 1, 100, settlements);
      const list = service.listDiscrepancies('t1');
      expect(list).toHaveLength(1);
      expect(list[0].tenantId).toBe('t1');
    });

    it('filters by status', () => {
      const settlements: Settlement[] = [mkSettlement({ period: '2026-01' })];
      service.detectDiscrepancies('t1', '2026-01', 1, 100, settlements);

      const pending = service.listDiscrepancies('t1', 'pending');
      expect(pending).toHaveLength(1);

      const ack = service.listDiscrepancies('t1', 'acknowledged');
      expect(ack).toHaveLength(0);
    });
  });

  describe('acknowledgeDiscrepancy', () => {
    it('changes status from pending to acknowledged', () => {
      const settlements: Settlement[] = [mkSettlement({ period: '2026-01' })];
      service.detectDiscrepancies('t1', '2026-01', 1, 100, settlements);
      const id = service.listDiscrepancies('t1')[0].discrepancyId;

      service.acknowledgeDiscrepancy(id, 't1');
      const updated = service.listDiscrepancies('t1', 'acknowledged');
      expect(updated).toHaveLength(1);
      expect(updated[0].status).toBe('acknowledged');
    });

    it('does not acknowledge discrepancy from different tenant', () => {
      const settlements: Settlement[] = [mkSettlement({ period: '2026-01' })];
      service.detectDiscrepancies('t1', '2026-01', 1, 100, settlements);
      const id = service.listDiscrepancies('t1')[0].discrepancyId;

      service.acknowledgeDiscrepancy(id, 't2'); // wrong tenant
      const stillPending = service.listDiscrepancies('t1', 'pending');
      expect(stillPending).toHaveLength(1);
    });
  });

  describe('clear', () => {
    it('clears all discrepancies', () => {
      const settlements: Settlement[] = [mkSettlement({ period: '2026-01' })];
      service.detectDiscrepancies('t1', '2026-01', 1, 100, settlements);
      service.clear();
      expect(service.listDiscrepancies('t1')).toHaveLength(0);
    });
  });

  describe('autoReconcile (K15-4)', () => {
    it('auto-resolves discrepancies with diffPct ≤ 1%', () => {
      const closeSettlement: Settlement = {
        ...mkSettlement(),
        splitRecords: [
          {
            recordId: 'sr-1',
            billId: 'bill-1',
            tenantId: 't1',
            skillId: 'skill-a',
            revenue: 100,
            splitRatio: 'standard',
            skillOwnerAmount: 99,
            platformAmount: 1,
            createdAt: '2026-02-01T00:00:00Z',
          },
        ],
      };
      service.detectDiscrepancies('t1', '2026-01', 1, 100, [closeSettlement]);
      const reconciled = service.autoReconcile('t1');
      expect(reconciled.length).toBeGreaterThan(0);
      const stillPending = service.listDiscrepancies('t1', 'pending');
      expect(stillPending).toHaveLength(0);
    });

    it('does not auto-resolve critical discrepancies (> 5%)', () => {
      const settlements: Settlement[] = [mkSettlement({ period: '2026-01' })];
      service.detectDiscrepancies('t1', '2026-01', 1, 100, settlements);
      const reconciled = service.autoReconcile('t1');
      expect(reconciled).toHaveLength(0);
      const stillPending = service.listDiscrepancies('t1', 'pending');
      expect(stillPending).toHaveLength(1);
    });
  });

  describe('resolveDiscrepancy (K15-4)', () => {
    it('manually resolves a discrepancy', () => {
      const settlements: Settlement[] = [mkSettlement({ period: '2026-01' })];
      service.detectDiscrepancies('t1', '2026-01', 1, 100, settlements);
      const id = service.listDiscrepancies('t1')[0].discrepancyId;

      const resolved = service.resolveDiscrepancy(id, 't1');
      expect(resolved).not.toBeNull();
      expect(resolved!.status).toBe('resolved');
      expect(resolved!.acknowledgedAt).toBeTruthy();
    });

    it('returns null for non-existent discrepancy', () => {
      const result = service.resolveDiscrepancy('nonexistent', 't1');
      expect(result).toBeNull();
    });

    it('does not resolve discrepancy from different tenant', () => {
      const settlements: Settlement[] = [mkSettlement({ period: '2026-01' })];
      service.detectDiscrepancies('t1', '2026-01', 1, 100, settlements);
      const id = service.listDiscrepancies('t1')[0].discrepancyId;

      const result = service.resolveDiscrepancy(id, 't2');
      expect(result).toBeNull();
    });
  });
});
