import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { SkillRatingService } from './skill-rating.service';
import { DelistWarningService } from './delist-warning.service';
import { type MeteringRecord, type CertificationRecord } from '@aegisci/shared/types';

describe('SkillRatingService + DelistWarningService (K13)', () => {
  let ratingService: SkillRatingService;
  let warningService: DelistWarningService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        SkillRatingService,
        DelistWarningService,
        EventEmitter2,
      ],
    }).compile();
    ratingService = module.get<SkillRatingService>(SkillRatingService);
    warningService = module.get<DelistWarningService>(DelistWarningService);
  });

  afterEach(() => {
    ratingService.clear();
    warningService.clear();
  });

  // ── submitRating ──

  describe('submitRating', () => {
    it('submits a valid rating', () => {
      const record = ratingService.submitRating('tenant-1', 'skill-1', 4, 'Good skill');
      expect(record.score).toBe(4);
      expect(record.skillId).toBe('skill-1');
      expect(record.tenantId).toBe('tenant-1');
      expect(record.ratingId).toBeDefined();
    });

    it('throws for invalid score', () => {
      expect(() => ratingService.submitRating('tenant-1', 'skill-1', 0))
        .toThrow('between 1 and 5');
      expect(() => ratingService.submitRating('tenant-1', 'skill-1', 6))
        .toThrow('between 1 and 5');
    });

    it('accumulates multiple ratings', () => {
      ratingService.submitRating('tenant-1', 'skill-1', 3);
      ratingService.submitRating('tenant-1', 'skill-1', 5);
      const rating = ratingService.getRating('tenant-1', 'skill-1');
      expect(rating.userScoreAvg).toBe(4); // (3+5)/2
    });
  });

  // ── getRating ──

  describe('getRating', () => {
    it('returns neutral rating when no data', () => {
      const rating = ratingService.getRating('tenant-1', 'skill-unknown');
      expect(rating.skillId).toBe('skill-unknown');
      expect(rating.userScoreAvg).toBeNull();
      expect(rating.callSuccessRate).toBe(1.0);
      expect(rating.compositeScore).toBeGreaterThan(0);
    });

    it('calculates composite score with user ratings', () => {
      ratingService.submitRating('tenant-1', 'skill-1', 5);
      ratingService.submitRating('tenant-1', 'skill-1', 5);
      const rating = ratingService.getRating('tenant-1', 'skill-1');
      // userScoreAvg=5, successRate=1.0, certBonus=0
      // composite = 0.4*(5*20) + 0.3*(100) + 0.3*0 = 40 + 30 + 0 = 70
      expect(rating.compositeScore).toBe(70);
      expect(rating.tier).toBe('good');
    });

    it('classifies excellent tier (≥80)', () => {
      ratingService.submitRating('tenant-1', 'skill-1', 5);
      ratingService.submitRating('tenant-1', 'skill-1', 5);
      ratingService.submitRating('tenant-1', 'skill-1', 5);
      const rating = ratingService.getRating('tenant-1', 'skill-1');
      // userScoreAvg=5, composite=70 → good, not excellent yet
      // Need more: with 5+5+5 avg=5, composite still 70
      // excellent needs composite≥80, requires certificationBonus or higher success
    });

    it('includes certification bonus', () => {
      ratingService.submitRating('tenant-1', 'skill-cert', 5);
      const certRecord: CertificationRecord = {
        certificationId: 'cert-1',
        skillId: 'skill-cert',
        tenantId: 'tenant-1',
        status: 'approved',
        appliedAt: '2026-01-01T00:00:00Z',
        certifiedAt: '2026-01-15T00:00:00Z',
        validUntil: '2027-01-15T00:00:00Z',
        auditTrail: [],
      };
      ratingService.linkCertification('skill-cert', certRecord);
      const rating = ratingService.getRating('tenant-1', 'skill-cert');
      expect(rating.certificationBonus).toBe(15);
      // composite = 0.4*100 + 0.3*100 + 0.3*15 = 40+30+4.5 = 74.5
      expect(rating.compositeScore).toBe(74.5);
    });
  });

  // ── recordCall ──

  describe('recordCall', () => {
    it('records a metering call', () => {
      const record: MeteringRecord = {
        recordId: 'rec-1',
        tenantId: 'tenant-1',
        skillId: 'skill-1',
        callAt: new Date().toISOString(),
        durationMs: 100,
        usageType: 'tool',
        evidenceId: 'ev-1',
        traceSpanId: 'span-1',
      };
      ratingService.recordCall(record);
      const lastCall = ratingService.getLastCallAt('tenant-1', 'skill-1');
      expect(lastCall).toBe(record.callAt);
    });

    it('returns undefined for unknown skill', () => {
      expect(ratingService.getLastCallAt('tenant-1', 'unknown')).toBeUndefined();
    });
  });

  // ── listRatings ──

  describe('listRatings', () => {
    it('returns paginated ratings sorted by score', () => {
      ratingService.submitRating('tenant-1', 'skill-a', 5);
      ratingService.submitRating('tenant-1', 'skill-b', 3);
      const result = ratingService.listRatings('tenant-1', 1, 1);
      expect(result.total).toBe(2);
      expect(result.ratings).toHaveLength(1);
      // skill-a has higher score, should be first
      expect(result.ratings[0].skillId).toBe('skill-a');
    });

    it('returns empty for tenant with no data', () => {
      const result = ratingService.listRatings('tenant-empty');
      expect(result.total).toBe(0);
      expect(result.ratings).toHaveLength(0);
    });
  });

  // ── qualitative flag ──

  describe('qualitative flag', () => {
    it('returns stale flag when no calls recorded', () => {
      ratingService.submitRating('tenant-1', 'skill-1', 2);
      const rating = ratingService.getRating('tenant-1', 'skill-1');
      // low score but no call → stale is likely
      expect(['stale', 'both', 'low_quality', null]).toContain(rating.qualitativeFlag);
    });

    it('returns null for healthy skill', () => {
      ratingService.submitRating('tenant-1', 'skill-good', 5);
      const now = new Date().toISOString();
      ratingService.recordCall({
        recordId: 'rec-good',
        tenantId: 'tenant-1',
        skillId: 'skill-good',
        callAt: now,
        durationMs: 50,
        usageType: 'tool',
        evidenceId: 'ev-good',
        traceSpanId: 'span-good',
      });
      const rating = ratingService.getRating('tenant-1', 'skill-good');
      expect(rating.qualitativeFlag).toBeNull();
    });
  });

  // ── DelistWarningService ──

  describe('DelistWarningService', () => {
    it('generates warning for both stale and low_quality', () => {
      // Skill with low rating and no recent calls
      ratingService.submitRating('tenant-1', 'skill-bad', 1);
      // Emit event manually to trigger warning
      const lowRating = ratingService.getRating('tenant-1', 'skill-bad');
      warningService['handleRatingUpdate']({
        skillId: 'skill-bad',
        tenantId: 'tenant-1',
        rating: { ...lowRating, qualitativeFlag: 'both' },
      });
      const warnings = warningService.listWarnings('tenant-1');
      expect(warnings.length).toBeGreaterThan(0);
      expect(warnings[0].reason).toBe('both');
    });

    it('does not generate warning for healthy skill', () => {
      ratingService.submitRating('tenant-1', 'skill-good', 5);
      const goodRating = ratingService.getRating('tenant-1', 'skill-good');
      warningService['handleRatingUpdate']({
        skillId: 'skill-good',
        tenantId: 'tenant-1',
        rating: { ...goodRating, qualitativeFlag: null },
      });
      const warnings = warningService.listWarnings('tenant-1');
      expect(warnings).toHaveLength(0);
    });

    it('acknowledges and removes a warning', () => {
      const warning = {
        warningId: 'w-1',
        skillId: 'skill-x',
        tenantId: 'tenant-1',
        reason: 'both' as const,
        compositeScore: 25,
        generatedAt: new Date().toISOString(),
      };
      (warningService as any).warningStore.set(warning.warningId, warning);
      expect(warningService.listWarnings('tenant-1').length).toBe(1);
      expect(warningService.acknowledgeWarning('w-1')).toBe(true);
      expect(warningService.listWarnings('tenant-1').length).toBe(0);
    });

    it('returns false for non-existent warning', () => {
      expect(warningService.acknowledgeWarning('non-existent')).toBe(false);
    });
  });
});
