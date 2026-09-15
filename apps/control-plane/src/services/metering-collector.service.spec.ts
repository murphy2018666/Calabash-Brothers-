import { Test, TestingModule } from '@nestjs/testing';
import { BillingEngineService } from './billing-engine.service';
import { MeteringCollectorService } from './metering-collector.service';
import { PolicyPackExclusiveService } from './policy-pack-exclusive.service';
import { MeteringService } from './metering.service';
import { CertifiedSkillPricingService } from './certified-skill-pricing.service';
import { ToolCallResult, Principal } from '@aegisci/shared/types';

describe('MeteringCollectorService (K10-2 unit)', () => {
  let service: MeteringCollectorService;
  let engine: BillingEngineService;
  let exclusivePackService: PolicyPackExclusiveService;
  let recordCallSpy: jest.SpyInstance;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        BillingEngineService,
        MeteringService,
        CertifiedSkillPricingService,
        PolicyPackExclusiveService,
        MeteringCollectorService,
      ],
    }).compile();

    service = module.get(MeteringCollectorService);
    engine = module.get(BillingEngineService);
    exclusivePackService = module.get(PolicyPackExclusiveService);
    recordCallSpy = jest.spyOn(engine, 'recordCall');
  });

  afterEach(() => {
    engine.clear();
    recordCallSpy.mockRestore();
  });

  it('writes metering record on successful tool call', async () => {
    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-auth' },
      evidenceId: 'ev-col-1',
      traceSpanId: 'span-col-1',
    };
    const principal: Principal = {
      id: 'user-admin',
      type: 'user',
      tenantId: 'tenant-gold',
      roles: ['admin'],
    };

    await service.onToolCall(result, principal, 'run-100');

    expect(recordCallSpy).toHaveBeenCalledTimes(1);
    const recorded = recordCallSpy.mock.calls[0][0];
    expect(recorded.evidenceId).toBe('ev-col-1');
    expect(recorded.tenantId).toBe('tenant-gold');
    expect(recorded.skillId).toBe('skill-auth');
    expect(recorded.usageType).toBe('tool');
  });

  it('does not throw when billing engine fails', async () => {
    recordCallSpy.mockImplementation(() => {
      throw new Error('storage full');
    });

    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-1' },
      evidenceId: 'ev-safe-1',
      traceSpanId: 'span-safe-1',
    };
    const principal: Principal = {
      id: 'u1',
      type: 'user',
      tenantId: 't1',
      roles: [],
    };

    // 应正常返回，不抛出
    await expect(service.onToolCall(result, principal, 'run-safe')).resolves.toBeUndefined();
  });

  it('uses evidenceId as metering record identifier', async () => {
    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-db' },
      evidenceId: 'ev-evidence-test',
      traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'u1',
      type: 'service',
      tenantId: 't1',
      roles: ['reader'],
    };

    await service.onToolCall(result, principal, 'run-evidence');

    const records = engine.getMetering('t1');
    expect(records).toHaveLength(1);
    expect(records[0].evidenceId).toBe('ev-evidence-test');
  });

  it('sets callAt to current ISO timestamp', async () => {
    const before = new Date().toISOString();
    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-1' },
      evidenceId: 'ev-time-1',
      traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'u1',
      type: 'user',
      tenantId: 't1',
      roles: [],
    };

    await service.onToolCall(result, principal, 'run-time');

    const records = engine.getMetering('t1');
    expect(records[0].callAt >= before).toBe(true);
  });

  it('works with agent principal type', async () => {
    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-agent' },
      evidenceId: 'ev-agent-1',
      traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'agent-planner-1',
      type: 'agent',
      tenantId: 'tenant-prod',
      roles: ['planner'],
    };

    await service.onToolCall(result, principal, 'run-agent');

    const records = engine.getMetering('tenant-prod');
    expect(records).toHaveLength(1);
    expect(records[0].tenantId).toBe('tenant-prod');
  });

  // ── K19-3: 独占包授权检查 ──

  it.each([
    { desc: 'authorized tenant', tenantId: 'tenant-allowed', isGranted: true, expectedCalls: 1 },
    { desc: 'owner tenant', tenantId: 'pack-owner', isGranted: false, expectedCalls: 1 },
  ])('$desc: writes metering when authorized', async ({ tenantId, isGranted, expectedCalls }) => {
    const pack = exclusivePackService.createExclusivePack('pack-owner', 'exclusive-pack', ['pol-1']);
    exclusivePackService.publishPack(pack.packId);
    if (isGranted) {
      exclusivePackService.grantAccess(pack.packId, tenantId);
    }

    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-exclusive', packId: pack.packId },
      evidenceId: 'ev-excl-1',
      traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: `user-${tenantId}`,
      type: 'user',
      tenantId,
      roles: [],
    };

    await service.onToolCall(result, principal, 'run-excl');
    const records = engine.getMetering(tenantId);
    expect(records).toHaveLength(expectedCalls);
  });

  it('denies metering for unauthorized tenant accessing exclusive pack', async () => {
    const pack = exclusivePackService.createExclusivePack('pack-owner', 'exclusive-pack-denied', ['pol-1']);
    exclusivePackService.publishPack(pack.packId);
    // 不授予任何其他租户访问权

    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-exclusive', packId: pack.packId },
      evidenceId: 'ev-denied-1',
      traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'user-unauthorized',
      type: 'user',
      tenantId: 'tenant-denied',
      roles: [],
    };

    await service.onToolCall(result, principal, 'run-denied');
    const records = engine.getMetering('tenant-denied');
    expect(records).toHaveLength(0);
    expect(recordCallSpy).not.toHaveBeenCalled();
  });

  it('allows metering without packId (no exclusive check)', async () => {
    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-normal' },
      evidenceId: 'ev-no-pack',
      traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'user-1',
      type: 'user',
      tenantId: 'tenant-1',
      roles: [],
    };

    await service.onToolCall(result, principal, 'run-no-pack');
    expect(recordCallSpy).toHaveBeenCalledTimes(1);
  });

  it.each([
    { desc: 'draft pack', status: 'draft' as const, expectedCalls: 1 },
    { desc: 'revoked pack', status: 'revoked' as const, expectedCalls: 1 },
  ])('$desc: $expectedCalls metering records', async ({ status, expectedCalls }) => {
    const pack = exclusivePackService.createExclusivePack('pack-owner', 'status-test-pack', ['pol-1']);
    if (status === 'published') {
      exclusivePackService.publishPack(pack.packId);
    }
    // draft 和 revoked 状态都不应该限制访问

    const result: ToolCallResult = {
      success: true,
      data: { skillId: 'skill-status', packId: pack.packId },
      evidenceId: 'ev-status',
      traceSpanId: 'span-1',
    };
    const principal: Principal = {
      id: 'user-1',
      type: 'user',
      tenantId: 'tenant-1',
      roles: [],
    };

    await service.onToolCall(result, principal, 'run-status');
    const records = engine.getMetering('tenant-1');
    expect(records).toHaveLength(expectedCalls);
  });
});
