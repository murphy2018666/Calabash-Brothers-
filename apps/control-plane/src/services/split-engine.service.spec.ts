import { Test, TestingModule } from '@nestjs/testing';
import { SplitEngineService } from '../services/split-engine.service';

describe('SplitEngineService (K11)', () => {
  let service: SplitEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [SplitEngineService],
    }).compile();
    service = module.get<SplitEngineService>(SplitEngineService);
  });

  afterEach(() => {
    service.clear();
  });

  describe('calculateSplit', () => {
    it.each([
      ['standard', 80, 20, 100, 80, 20],
      ['certified', 90, 10, 100, 90, 10],
    ])('ratio=%s: skillOwner=%d%%, platform=%d%% on revenue=%d',
      (ratio, skillOwnerPct, platformPct, revenue, expSkillOwner, expPlatform) => {
        const record = service.calculateSplit(
          'bill-1', 'tenant-1', 'skill-1', revenue,
          { ratio: ratio as any, skillOwnerPct, platformPct },
        );
        expect(record.skillOwnerAmount).toBe(expSkillOwner);
        expect(record.platformAmount).toBe(expPlatform);
        expect(record.splitRatio).toBe(ratio);
        expect(record.revenue).toBe(revenue);
      },
    );

    it('decimal precision: toFixed(2) rounding', () => {
      const record = service.calculateSplit(
        'bill-1', 'tenant-1', 'skill-3', 33.33,
        { ratio: 'standard', skillOwnerPct: 80, platformPct: 20 },
      );
      expect(record.skillOwnerAmount).toBeCloseTo(26.66, 2);
      expect(record.platformAmount).toBeCloseTo(6.67, 2);
    });

    it('free tier: 0 revenue', () => {
      const record = service.calculateSplit(
        'bill-1', 'tenant-1', 'skill-1', 0,
        { ratio: 'standard', skillOwnerPct: 80, platformPct: 20 },
      );
      expect(record.skillOwnerAmount).toBe(0);
      expect(record.platformAmount).toBe(0);
    });
  });

  describe('setSplitModel / getSplitModel', () => {
    it('default model is standard 80/20', () => {
      const model = service.getSplitModel('tenant-1', 'skill-1');
      expect(model.ratio).toBe('standard');
      expect(model.skillOwnerPct).toBe(80);
      expect(model.platformPct).toBe(20);
    });

    it('set and get custom model', () => {
      service.setSplitModel('tenant-1', 'skill-1', {
        ratio: 'certified',
        skillOwnerPct: 90,
        platformPct: 10,
        certifiedAt: '2026-09-01T00:00:00Z',
      });
      const model = service.getSplitModel('tenant-1', 'skill-1');
      expect(model.ratio).toBe('certified');
      expect(model.skillOwnerPct).toBe(90);
      expect(model.platformPct).toBe(10);
      expect(model.certifiedAt).toBe('2026-09-01T00:00:00Z');
    });

    it('different skills can have different models', () => {
      service.setSplitModel('tenant-1', 'skill-a', { ratio: 'standard', skillOwnerPct: 80, platformPct: 20 });
      service.setSplitModel('tenant-1', 'skill-b', { ratio: 'certified', skillOwnerPct: 90, platformPct: 10 });
      expect(service.getSplitModel('tenant-1', 'skill-a').ratio).toBe('standard');
      expect(service.getSplitModel('tenant-1', 'skill-b').ratio).toBe('certified');
    });
  });

  describe('getSplitRecords', () => {
    it.each([
      { desc: 'returns records for tenant', billId: undefined, expected: 2 },
      { desc: 'filters by billId', billId: 'bill-1', expected: 2, extraBill: false },
      { desc: 'filters by different billId', billId: 'bill-2', expected: 1, extraBill: true },
    ])('$desc', ({ desc: _desc, billId, expected, extraBill }) => {
      service.calculateSplit('bill-1', 'tenant-1', 'skill-1', 100, { ratio: 'standard', skillOwnerPct: 80, platformPct: 20 });
      service.calculateSplit('bill-1', 'tenant-1', 'skill-2', 50, { ratio: 'standard', skillOwnerPct: 80, platformPct: 20 });
      if (extraBill) {
        service.calculateSplit('bill-2', 'tenant-1', 'skill-1', 50, { ratio: 'standard', skillOwnerPct: 80, platformPct: 20 });
      }
      const records = service.getSplitRecords('tenant-1', billId as any);
      expect(records).toHaveLength(expected);
      if (billId) expect(records[0].billId).toBe(billId);
    });
  });

  describe('getAvailableRatios', () => {
    it('returns both ratios', () => {
      const ratios = service.getAvailableRatios();
      expect(ratios).toContain('standard');
      expect(ratios).toContain('certified');
      expect(ratios).toHaveLength(2);
    });
  });
});
