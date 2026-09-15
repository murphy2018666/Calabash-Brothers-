import { Test, TestingModule } from '@nestjs/testing';
import { CertificationEngineService } from './certification-engine.service';
import { CertificationRecord } from '@aegisci/shared/types';

describe('CertificationEngineService (K12-1)', () => {
  let service: CertificationEngineService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CertificationEngineService],
    }).compile();
    service = module.get<CertificationEngineService>(CertificationEngineService);
  });

  afterEach(() => {
    service.clear();
  });

  describe('applyCertification', () => {
    it('creates a pending certification record', () => {
      const record = service.applyCertification('skill-1', 'tenant-1');
      expect(record.status).toBe('pending');
      expect(record.skillId).toBe('skill-1');
      expect(record.tenantId).toBe('tenant-1');
      expect(record.certificationId).toBeDefined();
      expect(record.appliedAt).toBeDefined();
      expect(record.validUntil).toBeDefined();
      expect(record.auditTrail).toHaveLength(1);
      expect(record.auditTrail[0].action).toBe('applied');
    });

    it('has audit trail with correct actor', () => {
      const record = service.applyCertification('skill-2', 'tenant-2');
      expect(record.auditTrail[0].actor).toBe('tenant-2');
      expect(record.auditTrail[0].note).toContain('application submitted');
    });
  });

  describe('startReview', () => {
    it('transitions pending → reviewing', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      const reviewed = service.startReview(cert.certificationId);
      expect(reviewed.status).toBe('reviewing');
      expect(reviewed.auditTrail).toHaveLength(2);
      expect(reviewed.auditTrail[1].action).toBe('review_started');
    });

    it('rejects non-pending certification', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      service.reviewCertification(cert.certificationId, true, 'reviewer-1');
      expect(() => service.startReview(cert.certificationId))
        .toThrow("status 'approved'");
    });
  });

  describe('reviewCertification', () => {
    it('approves a certification', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      const reviewed = service.reviewCertification(cert.certificationId, true, 'reviewer-1', 'All checks passed');
      expect(reviewed.status).toBe('approved');
      expect(reviewed.reviewedAt).toBeDefined();
      expect(reviewed.reviewerId).toBe('reviewer-1');
      expect(reviewed.reviewNote).toBe('All checks passed');
      expect(reviewed.certifiedAt).toBeDefined();
      expect(reviewed.auditTrail).toHaveLength(2);
    });

    it('rejects a certification', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      const reviewed = service.reviewCertification(cert.certificationId, false, 'reviewer-1', 'Failed security check');
      expect(reviewed.status).toBe('rejected');
      expect(reviewed.reviewNote).toBe('Failed security check');
    });

    it('throws for non-existent certification', () => {
      expect(() => service.reviewCertification('non-existent', true, 'r1'))
        .toThrow('not found');
    });

    it('throws for already-reviewed certification', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      service.reviewCertification(cert.certificationId, true, 'reviewer-1');
      expect(() => service.reviewCertification(cert.certificationId, false, 'reviewer-2'))
        .toThrow("status 'approved'");
    });
  });

  describe('suspendCertification', () => {
    it('suspends an approved certification', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      service.reviewCertification(cert.certificationId, true, 'reviewer-1');
      const suspended = service.suspendCertification(cert.certificationId, 'User complaint under review');
      expect(suspended.status).toBe('suspended');
      expect(suspended.auditTrail.some((e) => e.action === 'suspended')).toBe(true);
    });

    it('throws for non-approved certification', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      expect(() => service.suspendCertification(cert.certificationId))
        .toThrow("status 'pending'");
    });
  });

  describe('resumeCertification', () => {
    it('resumes a suspended certification', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      service.reviewCertification(cert.certificationId, true, 'reviewer-1');
      service.suspendCertification(cert.certificationId, 'Temporary hold');
      const resumed = service.resumeCertification(cert.certificationId);
      expect(resumed.status).toBe('approved');
    });

    it('throws for non-suspended certification', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      expect(() => service.resumeCertification(cert.certificationId))
        .toThrow("status 'pending'");
    });
  });

  describe('isCertified', () => {
    it('returns true for active certified skill', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      service.reviewCertification(cert.certificationId, true, 'reviewer-1');
      expect(service.isCertified('tenant-1', 'skill-1')).toBe(true);
    });

    it('returns false for non-certified skill', () => {
      expect(service.isCertified('tenant-1', 'skill-1')).toBe(false);
    });

    it('returns false for rejected certification', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      service.reviewCertification(cert.certificationId, false, 'reviewer-1');
      expect(service.isCertified('tenant-1', 'skill-1')).toBe(false);
    });

    it('returns false for suspended certification', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      service.reviewCertification(cert.certificationId, true, 'reviewer-1');
      service.suspendCertification(cert.certificationId);
      expect(service.isCertified('tenant-1', 'skill-1')).toBe(false);
    });
  });

  describe('listCertifications', () => {
    it('returns paginated results', () => {
      service.applyCertification('skill-1', 'tenant-1');
      service.applyCertification('skill-2', 'tenant-1');
      const result = service.listCertifications({ tenantId: 'tenant-1', page: 1, pageSize: 1 });
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(1);
      expect(result.records).toHaveLength(1);
    });

    it('filters by status', () => {
      const c1 = service.applyCertification('skill-1', 'tenant-1');
      service.applyCertification('skill-2', 'tenant-1');
      service.reviewCertification(c1.certificationId, true, 'reviewer-1');
      const result = service.listCertifications({ tenantId: 'tenant-1', status: 'approved' });
      expect(result.total).toBe(1);
    });

    it('filters by skillId', () => {
      service.applyCertification('skill-1', 'tenant-1');
      service.applyCertification('skill-2', 'tenant-1');
      const result = service.listCertifications({ tenantId: 'tenant-1', skillId: 'skill-1' });
      expect(result.total).toBe(1);
      expect(result.records[0].skillId).toBe('skill-1');
    });
  });

  describe('getCertification', () => {
    it('returns certification for matching tenant', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      const retrieved = service.getCertification(cert.certificationId, 'tenant-1');
      expect(retrieved.skillId).toBe('skill-1');
    });

    it('throws on tenant mismatch', () => {
      const cert = service.applyCertification('skill-1', 'tenant-1');
      expect(() => service.getCertification(cert.certificationId, 'tenant-2'))
        .toThrow('tenant mismatch');
    });

    it('throws on non-existent certification', () => {
      expect(() => service.getCertification('non-existent'))
        .toThrow('not found');
    });
  });
});
