import { Test, TestingModule } from '@nestjs/testing';
import { CertificationMarkService } from './certification-mark.service';

describe('CertificationMarkService (K12-2)', () => {
  let service: CertificationMarkService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [CertificationMarkService],
    }).compile();
    service = module.get<CertificationMarkService>(CertificationMarkService);
  });

  describe('generateCertifiedMark', () => {
    it('generates a valid mark with correct prefix', () => {
      const mark = service.generateCertifiedMark('skill-1', '2026-01-15T10:00:00Z');
      expect(mark).toContain('AEGISCIA-CERT-');
      expect(mark).toContain('skill-1');
      // Format: AEGISCIA-CERT-{skillId}-{certifiedAtHash(12)}-{signature(64)}
      // Signature is last 64 chars after the last '-'
      const parts = mark.split('-');
      expect(parts[0]).toBe('AEGISCIA');
      expect(parts[1]).toBe('CERT');
      // skill-1 spans parts[2] and parts[3]; hash is parts[4]; sig starts at parts[5]
      expect(parts.slice(2, 4).join('-')).toBe('skill-1');
      expect(parts[4]).toHaveLength(12); // hash prefix
      expect(parts[5]).toHaveLength(64); // signature
    });

    it('generates different marks for different certifiedAt', () => {
      const mark1 = service.generateCertifiedMark('skill-1', '2026-01-15T10:00:00Z');
      const mark2 = service.generateCertifiedMark('skill-1', '2026-02-15T10:00:00Z');
      expect(mark1).not.toBe(mark2);
    });

    it('generates deterministic mark for same inputs', () => {
      const mark1 = service.generateCertifiedMark('skill-1', '2026-01-15T10:00:00Z');
      const mark2 = service.generateCertifiedMark('skill-1', '2026-01-15T10:00:00Z');
      expect(mark1).toBe(mark2);
    });
  });

  describe('verifyCertifiedMark', () => {
    it('verifies a legitimately generated mark', () => {
      const mark = service.generateCertifiedMark('skill-1', '2026-01-15T10:00:00Z');
      const result = service.verifyCertifiedMark(mark);
      expect(result.valid).toBe(true);
      expect(result.skillId).toBe('skill-1');
      expect(result.certifiedAtHash).toHaveLength(12);
    });

    it('detects tampered mark', () => {
      const mark = service.generateCertifiedMark('skill-1', '2026-01-15T10:00:00Z');
      const tampered = mark.replace('skill-1', 'skill-2');
      const result = service.verifyCertifiedMark(tampered);
      expect(result.valid).toBe(false);
    });

    it('rejects malformed mark', () => {
      const result = service.verifyCertifiedMark('INVALID-MARK');
      expect(result.valid).toBe(false);
    });

    it('rejects empty mark', () => {
      const result = service.verifyCertifiedMark('');
      expect(result.valid).toBe(false);
    });

    it('extracts correct skillId from verified mark', () => {
      const mark = service.generateCertifiedMark('my-certified-skill', '2026-06-01T00:00:00Z');
      const result = service.verifyCertifiedMark(mark);
      expect(result.skillId).toBe('my-certified-skill');
    });
  });
});
