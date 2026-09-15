import { Test, TestingModule } from '@nestjs/testing';
import { CertificationBillingHookService } from './certification-billing-hook.service';
import { CertificationEngineService } from './certification-engine.service';
import { BillingEngineService } from './billing-engine.service';
import { MeteringService } from './metering.service';
import { CertifiedSkillPricingService } from './certified-skill-pricing.service';
import { SplitEngineService } from './split-engine.service';
import { PolicyPackExclusiveService } from './policy-pack-exclusive.service';

describe('CertificationBillingHookService (K20-2)', () => {
  let hookService: CertificationBillingHookService;
  let certificationEngine: CertificationEngineService;
  let splitEngine: SplitEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CertificationBillingHookService,
        CertificationEngineService,
        BillingEngineService,
        MeteringService,
        CertifiedSkillPricingService,
        SplitEngineService,
        PolicyPackExclusiveService,
      ],
    }).compile();
    hookService = module.get<CertificationBillingHookService>(CertificationBillingHookService);
    certificationEngine = module.get<CertificationEngineService>(CertificationEngineService);
    splitEngine = module.get<SplitEngineService>(SplitEngineService);
  });

  afterEach(() => {
    certificationEngine.clear();
    splitEngine.clear();
  });

  // ── onCertificationUpdated ──

  describe('onCertificationUpdated', () => {
    it('switches to certified rate when approved', () => {
      const record = certificationEngine.applyCertification('skill-a', 'tenant-1');
      const reviewed = certificationEngine.reviewCertification(record.certificationId, true, 'reviewer-1');

      hookService.onCertificationUpdated(reviewed);
      const model = hookService.getCurrentSplitModel('tenant-1', 'skill-a');

      expect(model.ratio).toBe('certified');
      expect(model.skillOwnerPct).toBe(90);
      expect(model.platformPct).toBe(10);
    });

    it('restores standard rate when rejected', () => {
      // 先设置认证费率
      hookService.switchToCertifiedRate('tenant-1', 'skill-a');

      const record = certificationEngine.applyCertification('skill-a', 'tenant-1');
      const reviewed = certificationEngine.reviewCertification(record.certificationId, false, 'reviewer-1');

      hookService.onCertificationUpdated(reviewed);
      const model = hookService.getCurrentSplitModel('tenant-1', 'skill-a');

      expect(model.ratio).toBe('standard');
      expect(model.skillOwnerPct).toBe(80);
      expect(model.platformPct).toBe(20);
    });

    it('restores standard rate when suspended', () => {
      const certRecord = certificationEngine.applyCertification('skill-a', 'tenant-1');
      certificationEngine.reviewCertification(certRecord.certificationId, true, 'reviewer-1');
      hookService.switchToCertifiedRate('tenant-1', 'skill-a');

      const suspended = certificationEngine.suspendCertification(certRecord.certificationId, 'dispute');
      hookService.onCertificationUpdated(suspended);

      const model = hookService.getCurrentSplitModel('tenant-1', 'skill-a');
      expect(model.ratio).toBe('standard');
    });

    it('does not change rate for pending/reviewing status', () => {
      const record = certificationEngine.applyCertification('skill-a', 'tenant-1');
      const reviewing = certificationEngine.startReview(record.certificationId);

      hookService.onCertificationUpdated(reviewing);
      const model = hookService.getCurrentSplitModel('tenant-1', 'skill-a');

      // 默认是 standard，未变更
      expect(model.ratio).toBe('standard');
    });

    it('handles resume back to certified', () => {
      const certRecord = certificationEngine.applyCertification('skill-a', 'tenant-1');
      certificationEngine.reviewCertification(certRecord.certificationId, true, 'reviewer-1');
      hookService.switchToCertifiedRate('tenant-1', 'skill-a');
      const suspended = certificationEngine.suspendCertification(certRecord.certificationId, 'dispute');
      hookService.onCertificationUpdated(suspended);

      // 恢复
      const resumed = certificationEngine.resumeCertification(certRecord.certificationId);
      hookService.onCertificationUpdated(resumed);

      const model = hookService.getCurrentSplitModel('tenant-1', 'skill-a');
      expect(model.ratio).toBe('certified');
    });
  });

  // ── switchToCertifiedRate ──

  describe('switchToCertifiedRate', () => {
    it('sets certified split model', () => {
      hookService.switchToCertifiedRate('tenant-1', 'skill-a');
      const model = hookService.getCurrentSplitModel('tenant-1', 'skill-a');

      expect(model.ratio).toBe('certified');
      expect(model.skillOwnerPct).toBe(90);
      expect(model.platformPct).toBe(10);
      expect(model.certifiedAt).toBeDefined();
    });

    it('overwrites existing model', () => {
      splitEngine.setSplitModel('tenant-1', 'skill-a', {
        ratio: 'standard', skillOwnerPct: 80, platformPct: 20,
      });
      hookService.switchToCertifiedRate('tenant-1', 'skill-a');
      const model = hookService.getCurrentSplitModel('tenant-1', 'skill-a');

      expect(model.ratio).toBe('certified');
    });
  });

  // ── restoreStandardRate ──

  describe('restoreStandardRate', () => {
    it('sets standard split model', () => {
      hookService.switchToCertifiedRate('tenant-1', 'skill-a');
      hookService.restoreStandardRate('tenant-1', 'skill-a');
      const model = hookService.getCurrentSplitModel('tenant-1', 'skill-a');

      expect(model.ratio).toBe('standard');
      expect(model.skillOwnerPct).toBe(80);
      expect(model.platformPct).toBe(20);
    });
  });

  // ── tenant isolation ──

  describe('tenant isolation', () => {
    it('keeps split models separate per tenant', () => {
      hookService.switchToCertifiedRate('tenant-1', 'skill-a');
      hookService.restoreStandardRate('tenant-2', 'skill-a');

      const m1 = hookService.getCurrentSplitModel('tenant-1', 'skill-a');
      const m2 = hookService.getCurrentSplitModel('tenant-2', 'skill-a');

      expect(m1.ratio).toBe('certified');
      expect(m2.ratio).toBe('standard');
    });
  });
});
