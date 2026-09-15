/**
 * 成本度量服务 (G3)
 *
 * 设计目标：基于 OTel Span attributes 聚合 runner/agent/token 消耗，
 * 输出结构化的成本摘要，支持租户级计费基准。
 *
 * 对应文档：
 * - DES-1 可观测选型（OpenTelemetry + Prometheus/Grafana）
 * - S9 工作包 G3：OTel导出与成本度量
 */
import { Injectable, Logger } from '@nestjs/common';
import type { TraceSpan } from '@aegisci/core/spi/trace';
import type { AuditEnvelope } from '@aegisci/shared/types';

/**
 * CostDimension —— 成本维度
 */
export type CostDimension = 'runner' | 'agent' | 'token' | 'gate' | 'audit';

/**
 * CostEntry —— 单笔成本记录
 */
export interface CostEntry {
  tenantId: string;
  dimension: CostDimension;
  entityId: string; // runnerId / agentId / runId
  metricName: string;
  value: number;
  unit: string; // ms / token / USD
  timestamp: string;
  traceSpanId?: string;
  skillId?: string; // 可选：关联的技能 ID（用于成本归因）
}

/**
 * CostSummary —— 租户/时间范围成本汇总
 */
export interface CostSummary {
  tenantId: string;
  from: string;
  to: string;
  totalUsd: number;
  byDimension: Record<CostDimension, DimensionCost>;
  byEntity: Record<string, EntityCost>;
}

export interface DimensionCost {
  dimension: CostDimension;
  totalValue: number;
  totalUnit: string;
  count: number;
}

export interface EntityCost {
  entityId: string;
  dimension: CostDimension;
  totalValue: number;
  totalUnit: string;
  count: number;
}

/**
 * SkillCostSummary —— 单技能成本汇总
 */
export interface SkillCostSummary {
  skillId: string;
  tenantId: string;
  from: string;
  to: string;
  totalUsd: number;
  byDimension: Record<CostDimension, DimensionCost>;
  entryCount: number;
}

/**
 * PricingPolicy —— 定价策略（可热更新）
 */
export interface PricingPolicy {
  /** 维度定价 */
  rates: Partial<Record<CostDimension, number>>; // USD per unit
  /** 租户折扣系数（0~1） */
  tenantDiscount?: Record<string, number>;
}

/**
 * 默认定价策略（USD per unit）
 */
const DEFAULT_RATES: Partial<Record<CostDimension, number>> = {
  runner: 0.0001,    // $0.0001 per ms ≈ $6/hour for continuous runner
  agent: 0.00005,    // $0.00005 per token (GPT-4 量级)
  token: 0.00001,    // $0.00001 per authentication token usage
  gate: 0.001,       // $0.001 per gate evaluation
  audit: 0.000001,   // $0.000001 per audit record (1M records ≈ $1)
};

@Injectable()
export class CostMetricService {
  private readonly logger = new Logger(CostMetricService.name);
  private readonly entries = new Array<CostEntry>();
  private pricingPolicy: PricingPolicy = { rates: { ...DEFAULT_RATES } };

  /**
   * record —— 记录一笔成本（从 Span 或 Audit 事件提取）
   */
  record(entry: Omit<CostEntry, 'timestamp'> & { timestamp?: string }): void {
    this.entries.push({ ...entry, timestamp: entry.timestamp ?? new Date().toISOString() });
  }

  /**
   * fromSpan —— 从 TraceSpan 提取成本条目
   *
   * 约定：Span attributes 中需包含：
   * - cost.dimension (runner|agent|token|gate|audit)
   * - cost.entity (具体实体 ID)
   * - cost.value (数值，unit 由 dimension 决定)
   */
  static fromSpan(span: TraceSpan): CostEntry | null {
    const dim = span.attributes['cost.dimension'] as string;
    const validDims: CostDimension[] = ['runner', 'agent', 'token', 'gate', 'audit'];
    if (!dim || !validDims.includes(dim)) return null;
    const entityId = String(span.attributes['cost.entity'] ?? span.spanId);
    const value = Number(span.attributes['cost.value'] ?? 0);
    const unitMap: Record<string, string> = {
      runner: 'ms',
      agent: 'token',
      token: 'count',
      gate: 'eval',
      audit: 'record',
    };
    return {
      tenantId: String(span.attributes['tenant.id'] ?? 'unknown'),
      dimension: dim as CostDimension,
      entityId,
      metricName: `cost.${dim}`,
      value,
      unit: unitMap[dim],
      timestamp: new Date(span.startTime).toISOString(),
      traceSpanId: span.spanId,
    };
  }

  /**
   * fromAudit —— 从审计记录提取成本条目（Gate 裁决类）
   */
  static fromAudit(envelope: AuditEnvelope): CostEntry | null {
    const action = envelope.action;
    // gate裁决类动作
    if (action.startsWith('gate.')) {
      return {
        tenantId: envelope.tenantId,
        dimension: 'gate',
        entityId: envelope.evidenceId,
        metricName: 'cost.gate',
        value: 1,
        unit: 'eval',
        timestamp: envelope.timestamp,
        traceSpanId: envelope.traceSpanId,
      };
    }
    return null;
  }

  /**
   * getSummary —— 计算租户在时间范围内的成本汇总
   */
  getSummary(params: {
    tenantId: string;
    from: string;
    to: string;
  }): CostSummary {
    const { tenantId, from, to } = params;
    const filtered = this.entries.filter(
      (e) => e.tenantId === tenantId && e.timestamp >= from && e.timestamp <= to,
    );

    const byDimension = {} as Record<CostDimension, DimensionCost>;
    const byEntity = {} as Record<string, EntityCost>;

    for (const entry of filtered) {
      // byDimension
      if (!byDimension[entry.dimension]) {
        byDimension[entry.dimension] = {
          dimension: entry.dimension,
          totalValue: 0,
          totalUnit: entry.unit,
          count: 0,
        };
      }
      byDimension[entry.dimension].totalValue += entry.value;
      byDimension[entry.dimension].count += 1;

      // byEntity
      const entityKey = `${entry.dimension}:${entry.entityId}`;
      if (!byEntity[entityKey]) {
        byEntity[entityKey] = {
          entityId: entry.entityId,
          dimension: entry.dimension,
          totalValue: 0,
          totalUnit: entry.unit,
          count: 0,
        };
      }
      byEntity[entityKey].totalValue += entry.value;
      byEntity[entityKey].count += 1;
    }

    const totalUsd = this.toUsd(filtered);

    return { tenantId, from, to, totalUsd, byDimension, byEntity };
  }

  /**
   * getSkillCostSummary —— 按 skillId 归因的成本汇总
   *
   * 返回指定技能在时间范围内的成本统计，跨租户隔离。
   */
  getSkillCostSummary(params: {
    skillId: string;
    tenantId: string;
    from: string;
    to: string;
  }): SkillCostSummary {
    const { skillId, tenantId, from, to } = params;
    const filtered = this.entries.filter(
      (e) => e.tenantId === tenantId && e.skillId === skillId && e.timestamp >= from && e.timestamp <= to,
    );

    const byDimension = {} as Record<CostDimension, DimensionCost>;
    for (const entry of filtered) {
      if (!byDimension[entry.dimension]) {
        byDimension[entry.dimension] = {
          dimension: entry.dimension,
          totalValue: 0,
          totalUnit: entry.unit,
          count: 0,
        };
      }
      byDimension[entry.dimension].totalValue += entry.value;
      byDimension[entry.dimension].count += 1;
    }

    const totalUsd = this.toUsd(filtered);

    return { skillId, tenantId, from, to, totalUsd, byDimension, entryCount: filtered.length };
  }

  /**
   * toUsd —— 按当前定价策略将原始成本转换为 USD
   */
  toUsd(entries: CostEntry[]): number {
    const rates = this.pricingPolicy.rates;
    let total = 0;
    for (const e of entries) {
      const rate = rates[e.dimension] ?? 0;
      total += e.value * rate;
    }
    // 租户折扣
    const discount = this.pricingPolicy.tenantDiscount?.[entries[0]?.tenantId ?? ''] ?? 1;
    return Math.round(total * discount * 10000) / 10000; // 4位小数
  }

  /**
   * setPricingPolicy —— 更新定价策略（热更新，无需重启）
   */
  setPricingPolicy(policy: PricingPolicy): void {
    this.pricingPolicy = policy;
    this.logger.log(`[CostMetric] pricing policy updated: ${JSON.stringify(policy.rates)}`);
  }

  /**
   * getPricingPolicy —— 获取当前定价策略
   */
  getPricingPolicy(): PricingPolicy {
    return { ...this.pricingPolicy };
  }

  /**
   * clear —— 清空成本记录（测试用）
   */
  clear(): void {
    this.entries.length = 0;
  }

  /**
   * getCount —— 获取记录总数（测试用）
   */
  getCount(): number {
    return this.entries.length;
  }
}
