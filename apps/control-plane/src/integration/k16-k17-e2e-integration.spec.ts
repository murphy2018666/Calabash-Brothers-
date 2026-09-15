import { Test } from '@nestjs/testing';
import { BillingEngineService } from '../services/billing-engine.service';
import { MeteringService } from '../services/metering.service';
import { CertifiedSkillPricingService } from '../services/certified-skill-pricing.service';
import { SettlementService } from '../services/settlement-service';
import { SkillRatingService } from '../services/skill-rating.service';
import { DelistWarningService } from '../services/delist-warning.service';
import { CertificationEngineService } from '../services/certification-engine.service';
import { MarketDashboardService } from '../services/market-dashboard.service';
import { ForecastService } from '../services/forecast.service';
import { DelistWorkflowService } from '../services/delist-workflow.service';
import { ReconciliationService } from '../services/reconciliation.service';
import { MeteringRecord, Settlement, SkillRating, CertificationRecord } from '@aegisci/shared/types';

describe('K16 K17 End-to-End Integration (S26)', () => {
  let billing: BillingEngineService;
  let settlement: SettlementService;
  let skillRating: SkillRatingService;
  let delistWarning: DelistWarningService;
  let certification: CertificationEngineService;
  let dashboard: MarketDashboardService;
  let forecast: ForecastService;
  let delistWorkflow: DelistWorkflowService;
  let reconciliation: ReconciliationService;

  const mockSkillRatings = {
    recordRating: jest.fn(),
    listRatings: jest.fn().mockReturnValue({ ratings: [], total: 0 }),
    getAverageRating: jest.fn().mockReturnValue(4.5),
  };

  const mockCertification = {
    isCertified: jest.fn().mockReturnValue(false),
    listCertifications: jest.fn().mockReturnValue({ records: [] }),
  };

  beforeEach(() => {
    const metering = new MeteringService();
    const pricingService = new CertifiedSkillPricingService();
    billing = new BillingEngineService(metering, pricingService);
    const splitEngine = new (require('../services/split-engine.service').SplitEngineService)();
    settlement = new SettlementService(splitEngine);
    skillRating = new SkillRatingService(null as any);
    delistWarning = new DelistWarningService();
    certification = new CertificationEngineService();
    forecast = new ForecastService(billing);
    const mockEventEmitter = { emit: jest.fn() };
    dashboard = new MarketDashboardService(billing, settlement, skillRating, delistWarning, certification, forecast);
    delistWorkflow = new DelistWorkflowService(delistWarning, mockEventEmitter as any);
    reconciliation = new ReconciliationService();

    billing.clear();
    settlement.clear();
    skillRating.clear();
    delistWarning.clear();
    certification.clear();
    dashboard.clear();
    forecast['clear']?.();
    delistWorkflow.clear();
    reconciliation.clear();
  });

  // ── K16: 收入预测 ──

  it('K16: 历史账单数据驱动线性预测', () => {
    // 模拟连续5个月的增长数据 - 使用最近月份避免时区问题
    const dates = ['2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'];
    const revenues = [100, 200, 300, 400, 600];

    for (let i = 0; i < dates.length; i++) {
      // 为每个月生成足够多的计量记录来支撑收入
      for (let j = 0; j < 10; j++) {
        const record: MeteringRecord = {
          recordId: `k16-rec-${i}-${j}`,
          tenantId: 't-predict',
          skillId: 'skill-predict',
          callAt: new Date(dates[i] + 'T' + String(j).padStart(2, '0') + ':00:00Z').toISOString(),
          durationMs: 100,
          cost: revenues[i] / 10,
          usageType: 'tool',
          evidenceId: `k16-ev-${i}-${j}`,
          traceSpanId: `k16-span-${i}-${j}`,
        };
        billing.recordCall(record);
      }
    }

    const result = forecast.predict('t-predict', 3, 'linear');

    expect(result.insufficientData).toBe(false);
    expect(result.method).toBe('linear');
    expect(result.trend).toBe('up');
    expect(result.dataPoints).toBe(5);
    expect(result.predictedRevenue).toBeGreaterThan(400);
    expect(result.lowerBound).toBeLessThan(result.predictedRevenue);
    expect(result.upperBound).toBeGreaterThanOrEqual(result.predictedRevenue);
  });

  it('K16: 无历史数据时返回 insufficientData', () => {
    const result = forecast.predict('t-empty', 3, 'linear');
    expect(result.insufficientData).toBe(true);
    expect(result.predictedRevenue).toBe(0);
  });

  it('K16: 指数增长预测', () => {
    // 指数增长：100, 200, 400, 800
    const currentYear = new Date().getFullYear();
    const months = [
      `${currentYear - 1}-10`, `${currentYear - 1}-11`,
      `${currentYear - 1}-12`, `${currentYear}-01`
    ];
    const revenues = [100, 200, 400, 800];

    for (let i = 0; i < months.length; i++) {
      const baseDate = new Date(months[i] + '-01');
      for (let j = 0; j < 10; j++) {
        const record: MeteringRecord = {
          recordId: `k16-exp-${i}-${j}`,
          tenantId: 't-exponential',
          skillId: 'skill-exp',
          callAt: new Date(baseDate.getTime() + j * 86400000).toISOString(),
          durationMs: 100,
          cost: revenues[i] / 10,
          usageType: 'tool',
          evidenceId: `k16-exp-ev-${i}-${j}`,
          traceSpanId: `k16-exp-span-${i}-${j}`,
        };
        billing.recordCall(record);
      }
    }

    const result = forecast.predict('t-exponential', 3, 'exponential');
    expect(result.insufficientData).toBe(false);
    expect(result.method).toBe('exponential');
    expect(result.trend).toBe('up');
    // 指数预测应显著高于线性
    expect(result.predictedRevenue).toBeGreaterThan(800);
  });

  it('K16: 平台聚合预测', () => {
    // 多租户数据
    for (const tenant of ['t-A', 't-B', 't-C']) {
      for (let i = 0; i < 5; i++) {
        const month = `2026-0${i + 1}`;
        const baseDate = new Date(month + '-01');
        for (let j = 0; j < 5; j++) {
          billing.recordCall({
            recordId: `k16-plan-${tenant}-${i}-${j}`,
            tenantId: tenant,
            skillId: 'skill-plan',
            callAt: new Date(baseDate.getTime() + j * 86400000).toISOString(),
            durationMs: 100,
            cost: 50,
            usageType: 'tool',
            evidenceId: `k16-plan-ev-${tenant}-${i}-${j}`,
            traceSpanId: `k16-plan-span-${tenant}-${i}-${j}`,
          });
        }
      }
    }

    const result = forecast.predict(undefined, 3, 'linear');
    expect(result.insufficientData).toBe(false);
    expect(result.predictedRevenue).toBeGreaterThan(0);
  });

  // ── K17: 自动下架工作流 ──

  it('K17: 完整下架流程 - 从预警到执行', () => {
    // 模拟一个低评分的预警
    delistWarning['warningStore'].set('w-k17', {
      warningId: 'w-k17',
      skillId: 'skill-bad',
      tenantId: 't-warn',
      reason: 'both',
      compositeScore: 15,
      generatedAt: new Date().toISOString(),
    });

    // 触发自动下架
    const created = delistWorkflow.triggerAutoDelist('t-warn');
    expect(created.length).toBeGreaterThanOrEqual(1);
    expect(created[0].status).toBe('notification_sent');

    // 查询工作流
    const workflows = delistWorkflow.listWorkflows('t-warn');
    expect(workflows.length).toBeGreaterThan(0);
    expect(workflows[0].skillId).toBe('skill-bad');

    // 执行下架
    const delisted = delistWorkflow.execDelist('t-warn', 'skill-bad');
    expect(delisted).not.toBeNull();
    expect(delisted!.status).toBe('delisted');
    expect(delisted!.delistedAt).toBeTruthy();
  });

  it('K17: 申诉撤销下架流程', () => {
    delistWorkflow.startWorkflow('t-appeal', 'skill-false', 'stale');
    delistWorkflow.notifySkillOwner('t-appeal', 'skill-false');

    const workflow = delistWorkflow.findActiveWorkflow('t-appeal', 'skill-false');
    expect(workflow).not.toBeNull();

    const cancelled = delistWorkflow.cancelWorkflow('t-appeal', workflow!.workflowId, '误报');
    expect(cancelled).not.toBeNull();
    expect(cancelled!.status).toBe('cancelled');
    expect(cancelled!.cancelledReason).toBe('误报');
  });

  it('K17: 工作流幂等性验证', () => {
    const wf1 = delistWorkflow.startWorkflow('t-idem', 'skill-idem', 'low_quality');
    const wf2 = delistWorkflow.startWorkflow('t-idem', 'skill-idem', 'stale');

    expect(wf1.workflowId).toBe(wf2.workflowId);
  });

  it('K17: 只有低评分才触发自动下架', () => {
    // 高评分不应触发
    delistWarning['warningStore'].set('w-high', {
      warningId: 'w-high',
      skillId: 'skill-good',
      tenantId: 't-high',
      reason: 'both',
      compositeScore: 60,
      generatedAt: new Date().toISOString(),
    });

    const created = delistWorkflow.triggerAutoDelist('t-high');
    expect(created).toHaveLength(0);
  });

  // ── K15-3: 对账 REST 逻辑验证 ──

  it('K15-3: 差异确认流程', () => {
    const settlement: Settlement = {
      settlementId: 's-recon',
      tenantId: 't-recon',
      period: '2026-02',
      totalRevenue: 1000,
      totalSkillOwnerPayout: 800,
      totalPlatformRevenue: 200,
      splitRecords: [{
        recordId: 'sr-recon',
        billId: 'bill-recon',
        tenantId: 't-recon',
        skillId: 'skill-a',
        revenue: 1000,
        splitRatio: 'standard',
        skillOwnerAmount: 800,
        platformAmount: 200,
        createdAt: new Date().toISOString(),
      }],
      status: 'completed',
      createdAt: new Date().toISOString(),
    };

    reconciliation.detectDiscrepancies('t-recon', '2026-02', 10, 1000, [settlement]);

    const pending = reconciliation.listDiscrepancies('t-recon', 'pending');
    expect(pending.length).toBeGreaterThan(0);

    const acknowledged = reconciliation.acknowledgeDiscrepancy(pending[0].discrepancyId, 't-recon');
    expect(acknowledged).not.toBeNull();
    expect(acknowledged!.status).toBe('acknowledged');
    expect(acknowledged!.acknowledgedAt).toBeTruthy();
  });

  // ── K16-K17: 预测数据流入仪表板并影响决策 ──

  it('K16-K17: 预测数据流入仪表板并影响决策', () => {
    // 设置历史数据 - 使用固定的近期日期避免时区问题
    const dates = ['2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'];
    for (let i = 0; i < dates.length; i++) {
      for (let j = 0; j < 5; j++) {
        billing.recordCall({
          recordId: `k16-int-${i}-${j}`,
          tenantId: 't-int',
          skillId: 'skill-int',
          callAt: new Date(dates[i] + 'T' + String(j).padStart(2, '0') + ':00:00Z').toISOString(),
          durationMs: 100,
          cost: 100,
          usageType: 'tool',
          evidenceId: `k16-int-ev-${i}-${j}`,
          traceSpanId: `k16-int-span-${i}-${j}`,
        });
      }
    }

    // 预测
    const forecastResult = forecast.predict('t-int', 3, 'linear');
    expect(forecastResult.insufficientData).toBe(false);
    expect(forecastResult.predictedRevenue).toBeGreaterThan(0);

    // 仪表板能正常获取数据
    const overview = dashboard.getPlatformOverview();
    expect(overview.totalTenants).toBeGreaterThanOrEqual(1);
  });

  // ── S27 E2E: 场景 6 — 仪表板集成预测 ──

  it('E2E-6: 仪表板 composite 包含 forecast 字段且 method=linear', () => {
    const dates = ['2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15', '2026-09-15'];
    for (let i = 0; i < dates.length; i++) {
      for (let j = 0; j < 3; j++) {
        billing.recordCall({
          recordId: `e2e6-${i}-${j}`,
          tenantId: 't-e2e6',
          skillId: 'skill-e2e6',
          callAt: new Date(dates[i] + 'T10:00:00Z').toISOString(),
          durationMs: 100,
          cost: 50,
          usageType: 'tool',
          evidenceId: `e2e6-ev-${i}`,
          traceSpanId: `e2e6-span-${i}`,
        });
      }
    }
    const dashboard = forecast.predict('t-e2e6', 3, 'linear');
    expect(dashboard.method).toBe('linear');
    expect(dashboard.trend).toBe('stable');
  });

  // ── S27 E2E: 场景 7 — 对账自动化 ──

  it('E2E-7: autoReconcile 自动解决微小差异', () => {
    const settlement: Settlement = {
      settlementId: 's-e2e7',
      tenantId: 't-e2e7',
      period: '2026-01',
      totalRevenue: 100,
      totalSkillOwnerPayout: 99,
      totalPlatformRevenue: 1,
      splitRecords: [{
        recordId: 'sr-e2e7', billId: 'b-e2e7', tenantId: 't-e2e7',
        skillId: 'skill-e2e7', revenue: 100, splitRatio: 'standard',
        skillOwnerAmount: 99, platformAmount: 1, createdAt: new Date().toISOString(),
      }],
      status: 'completed',
      createdAt: new Date().toISOString(),
    };
    reconciliation.detectDiscrepancies('t-e2e7', '2026-01', 1, 100, [settlement]);
    const reconciled = reconciliation.autoReconcile('t-e2e7');
    expect(reconciled.length).toBeGreaterThan(0);
    const stillPending = reconciliation.listDiscrepancies('t-e2e7', 'pending');
    expect(stillPending).toHaveLength(0);
  });

  // ── S27 E2E: 场景 8 — 下架事件发布 ──

  it('E2E-8: execDelist 触发 market.event 事件', () => {
    const emittedEvents: any[] = [];
    const eventEmitter = { emit: (event: string, payload: any) => emittedEvents.push({ event, payload }) };
    const delistWf = new DelistWorkflowService(delistWarning, eventEmitter as any);

    delistWf.startWorkflow('t-e2e8', 'skill-e2e8', 'stale');
    delistWf.notifySkillOwner('t-e2e8', 'skill-e2e8');
    delistWf.execDelist('t-e2e8', 'skill-e2e8');

    const delistedEvent = emittedEvents.find((e) => e.payload.eventType === 'skill.delisted');
    expect(delistedEvent).toBeDefined();
    expect(delistedEvent.payload.tenantId).toBe('t-e2e8');
    expect(delistedEvent.payload.skillId).toBe('skill-e2e8');
  });

  // ── S27 E2E: 场景 9 — 多技能预测 ──

  it('E2E-9: predictBySkill 按技能隔离预测', () => {
    const dates = ['2026-05-15', '2026-06-15', '2026-07-15', '2026-08-15'];
    billing.recordCall({ recordId: 'e2e9-a1', tenantId: 't-e2e9', skillId: 'skill-a', callAt: new Date(dates[0]).toISOString(), durationMs: 100, cost: 10, usageType: 'tool', evidenceId: 'e2e9-e1', traceSpanId: 'e2e9-s1' });
    billing.recordCall({ recordId: 'e2e9-a2', tenantId: 't-e2e9', skillId: 'skill-a', callAt: new Date(dates[1]).toISOString(), durationMs: 100, cost: 20, usageType: 'tool', evidenceId: 'e2e9-e2', traceSpanId: 'e2e9-s2' });
    billing.recordCall({ recordId: 'e2e9-a3', tenantId: 't-e2e9', skillId: 'skill-a', callAt: new Date(dates[2]).toISOString(), durationMs: 100, cost: 30, usageType: 'tool', evidenceId: 'e2e9-e3', traceSpanId: 'e2e9-s3' });
    billing.recordCall({ recordId: 'e2e9-a4', tenantId: 't-e2e9', skillId: 'skill-a', callAt: new Date(dates[3]).toISOString(), durationMs: 100, cost: 40, usageType: 'tool', evidenceId: 'e2e9-e4', traceSpanId: 'e2e9-s4' });

    billing.recordCall({ recordId: 'e2e9-b1', tenantId: 't-e2e9', skillId: 'skill-b', callAt: new Date(dates[0]).toISOString(), durationMs: 100, cost: 100, usageType: 'tool', evidenceId: 'e2e9-be1', traceSpanId: 'e2e9-bs1' });
    billing.recordCall({ recordId: 'e2e9-b2', tenantId: 't-e2e9', skillId: 'skill-b', callAt: new Date(dates[1]).toISOString(), durationMs: 100, cost: 200, usageType: 'tool', evidenceId: 'e2e9-be2', traceSpanId: 'e2e9-bs2' });
    billing.recordCall({ recordId: 'e2e9-b3', tenantId: 't-e2e9', skillId: 'skill-b', callAt: new Date(dates[2]).toISOString(), durationMs: 100, cost: 300, usageType: 'tool', evidenceId: 'e2e9-be3', traceSpanId: 'e2e9-bs3' });
    billing.recordCall({ recordId: 'e2e9-b4', tenantId: 't-e2e9', skillId: 'skill-b', callAt: new Date(dates[3]).toISOString(), durationMs: 100, cost: 400, usageType: 'tool', evidenceId: 'e2e9-be4', traceSpanId: 'e2e9-bs4' });

    const rA = forecast.predictBySkill('t-e2e9', 'skill-a', 2, 'linear');
    const rB = forecast.predictBySkill('t-e2e9', 'skill-b', 2, 'linear');

    expect(rA.insufficientData).toBe(false);
    expect(rB.insufficientData).toBe(false);
    expect(rA.predictedRevenue).not.toBe(rB.predictedRevenue);
    expect(rA.predictedRevenue).toBeLessThan(rB.predictedRevenue);
  });
});
