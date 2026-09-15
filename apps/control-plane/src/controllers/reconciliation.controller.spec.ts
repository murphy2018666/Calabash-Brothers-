import { ReconciliationController } from './reconciliation.controller';
import { ReconciliationService, Discrepancy } from '../services/reconciliation.service';
import { NotFoundException, BadRequestException } from '@nestjs/common';

describe('ReconciliationController', () => {
  let controller: ReconciliationController;
  let service: ReconciliationService;

  beforeEach(() => {
    service = new ReconciliationService();
    controller = new ReconciliationController(service);
    service.clear();
  });

  it('returns empty array when no discrepancies exist', () => {
    const result = controller.listDiscrepancies('t1');
    expect(result).toEqual([]);
  });

  it('filters by severity', () => {
    // 手动向服务中插入一条差异
    service.detectDiscrepancies('t1', '2026-01', 1, 100, [
      {
        settlementId: 's1',
        tenantId: 't1',
        period: '2026-01',
        totalRevenue: 100,
        totalSkillOwnerPayout: 80,
        totalPlatformRevenue: 20,
        splitRecords: [{
          recordId: 'sr1',
          billId: 'b1',
          tenantId: 't1',
          skillId: 'skill-a',
          revenue: 100,
          splitRatio: 'standard',
          skillOwnerAmount: 80,
          platformAmount: 20,
          createdAt: new Date().toISOString(),
        }],
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    ]);

    const warnings = controller.listDiscrepancies('t1', undefined, 'warning');
    const criticals = controller.listDiscrepancies('t1', undefined, 'critical');

    // cost diff 20% → critical
    expect(warnings).toEqual([]);
    expect(criticals.length).toBeGreaterThanOrEqual(1);
  });

  it('throws BadRequestException for invalid severity', () => {
    expect(() => controller.listDiscrepancies('t1', undefined, 'invalid'))
      .toThrow('severity must be warning or critical');
  });

  it('acknowledges a discrepancy and returns updated record', () => {
    // 插入一条差异
    service.detectDiscrepancies('t1', '2026-01', 1, 100, [
      {
        settlementId: 's1',
        tenantId: 't1',
        period: '2026-01',
        totalRevenue: 100,
        totalSkillOwnerPayout: 80,
        totalPlatformRevenue: 20,
        splitRecords: [{
          recordId: 'sr1',
          billId: 'b1',
          tenantId: 't1',
          skillId: 'skill-a',
          revenue: 100,
          splitRatio: 'standard',
          skillOwnerAmount: 80,
          platformAmount: 20,
          createdAt: new Date().toISOString(),
        }],
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    ]);

    const disc = service.listDiscrepancies('t1')[0];
    expect(disc).toBeDefined();

    const result = controller.acknowledgeDiscrepancy(disc.discrepancyId, 't1');
    expect(result.status).toBe('acknowledged');
    expect(result.acknowledgedAt).toBeTruthy();
  });

  it('throws NotFoundException for non-existent discrepancy', () => {
    expect(() => controller.acknowledgeDiscrepancy('nonexistent-id', 't1'))
      .toThrow(NotFoundException);
  });

  it('throws BadRequestException when tenantId is missing for acknowledge', () => {
    expect(() => controller.acknowledgeDiscrepancy('some-id'))
      .toThrow('tenantId is required');
  });

  it('resolves a discrepancy and returns updated record', () => {
    service.detectDiscrepancies('t1', '2026-01', 1, 100, [
      {
        settlementId: 's1',
        tenantId: 't1',
        period: '2026-01',
        totalRevenue: 100,
        totalSkillOwnerPayout: 80,
        totalPlatformRevenue: 20,
        splitRecords: [{
          recordId: 'sr1',
          billId: 'b1',
          tenantId: 't1',
          skillId: 'skill-a',
          revenue: 100,
          splitRatio: 'standard',
          skillOwnerAmount: 80,
          platformAmount: 20,
          createdAt: new Date().toISOString(),
        }],
        status: 'pending',
        createdAt: new Date().toISOString(),
      },
    ]);

    const disc = service.listDiscrepancies('t1')[0];
    const result = controller.resolveDiscrepancy(disc.discrepancyId, 't1');
    expect(result.status).toBe('resolved');
    expect(result.acknowledgedAt).toBeTruthy();
  });

  it('throws NotFoundException for non-existent discrepancy resolve', () => {
    expect(() => controller.resolveDiscrepancy('nonexistent-id', 't1'))
      .toThrow(NotFoundException);
  });

  it('throws BadRequestException when tenantId is missing for resolve', () => {
    expect(() => controller.resolveDiscrepancy('some-id'))
      .toThrow('tenantId is required');
  });
});
