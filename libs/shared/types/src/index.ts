/**
 * AegisCI 共享类型定义
 * 对应设计文档：DES-3 DDD 上下文、DES-4 领域事件
 */

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 身份与权限
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type PrincipalType = 'user' | 'service' | 'agent';

export interface Principal {
  id: string;
  type: PrincipalType;
  tenantId: string;
  roles: string[];
}

export type RiskLevel = 'G1' | 'G2' | 'G3' | 'G4';

export type PolicyDecision = 'ALLOW' | 'DENY' | 'HALLOW';

export interface PolicyEvidence {
  evidenceId: string;
  policyVersion: string;
  decision: PolicyDecision;
  reason: string;
  rules: string[];
  timestamp: string;
}

export interface AuthorizeRequest {
  principal: Principal;
  action: string;
  resource: string;
  context: AuthorizeContext;
}

export interface AuthorizeContext {
  env?: string;
  branch?: string;
  riskLevel?: RiskLevel;
  [key: string]: unknown;
}

export interface AuthorizeResult {
  decision: PolicyDecision;
  evidence: PolicyEvidence;
  cacheHit: boolean;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Agent 与工具
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type AgentRole = 'planner' | 'reviewer' | 'tester' | 'security' | 'ops';

export interface AgentCard {
  agentId: string;
  role: AgentRole;
  displayName: string;
  modelId: string;
  capabilities: string[];
  riskTier: RiskLevel;
  tenantId: string;
}

export interface ToolCallRequest {
  toolName: string;
  action: string;
  resource: string;
  args: Record<string, unknown>;
  agentId: string;
  runId: string;
}

export interface ToolCallResult {
  success: boolean;
  data: unknown;
  error?: string;
  evidenceId: string;
  traceSpanId: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Blackboard
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type BlackboardEntryType = 'conclusion' | 'risk' | 'evidence' | 'summary';

export interface BlackboardEntry {
  entryId: string;
  runId: string;
  agentId: string;
  type: BlackboardEntryType;
  payload: Record<string, unknown>;
  traceSpanId: string;
  timestamp: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// Run 与流水线
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type RunStatus =
  | 'pending'
  | 'planning'
  | 'dispatching'
  | 'reviewing'
  | 'gate_blocked'
  | 'gate_passed'
  | 'deploying'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type RunStage =
  | 'trigger'
  | 'review'
  | 'test'
  | 'staging'
  | 'prod';

export interface Run {
  runId: string;
  tenantId: string;
  pipelineId: string;
  status: RunStatus;
  stage: RunStage;
  trigger: RunTrigger;
  createdAt: string;
  updatedAt: string;
}

export interface RunTrigger {
  event: 'push' | 'mr' | 'tag' | 'schedule' | 'api';
  ref: string;
  repo: string;
  actor: string;
  /** 触发提交 SHA（schedule 可缺省，由控制面派发时补默认分支 HEAD） */
  commit?: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 领域事件
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface DomainEvent<T = unknown> {
  eventId: string;
  eventType: string;
  aggregateId: string;
  aggregateType: string;
  tenantId: string;
  payload: T;
  timestamp: string;
  traceId: string;
  spanId: string;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 审计
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export interface AuditEnvelope {
  envelopeId: string;
  tenantId: string;
  principalId: string;
  principalType: PrincipalType;
  action: string;
  resource: string;
  evidenceId: string;
  traceSpanId: string;
  result: 'success' | 'denied' | 'failed';
  timestamp: string;
  metadata: Record<string, unknown>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 技能
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type SkillType = 'tool' | 'agent' | 'connector' | 'policy-pack';
export type SkillRiskTier = 'G1' | 'G2' | 'G3' | 'G4';
export type SkillState = 'registered' | 'reviewing' | 'approved' | 'active' | 'disabled' | 'revoked';

export interface SkillManifest {
  name: string;
  version: string;
  type: SkillType;
  description: string;
  tools?: string[];
  agent?: Partial<AgentCard>;
  dependencies?: string[];
  riskTier: SkillRiskTier;
  [key: string]: unknown;
  policyPreset?: Record<string, unknown>;
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 计量计费（K10）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type {
  PricingTier,
  PricingModel,
  MeteringRecord,
  BillStatus,
  MonthlyBill,
  BillLineItem,
  MeteringQuery,
  MeteringResponse,
  BillingStats,
} from './billing';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 分账结算（K11）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type {
  SplitRatio,
  SplitModel,
  SplitRecord,
  SettlementStatus,
  Settlement,
  SettlementQuery,
  SettlementResponse,
  SettlementStats,
} from './settlement';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 官方认证体系（K12）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type {
  CertificationStatus,
  AuditEntry,
  CertificationRecord,
  CertificationQuery,
  CertificationResponse,
  RefundStatus,
  RefundRecord,
  RefundQuery,
  RefundResponse,
} from './certification';

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 技能市场质量治理（K13）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

export type {
  RatingTier,
  UserRating,
  CallSuccessRate,
  QualitativeFlag,
  SkillRating,
  DelistWarning,
} from './rating';

export type { SkillDelistedEvent, SkillRestoredEvent, MarketEvent } from './events';

export type { BillingConsistencyReport, DiscrepancyItem } from './reconciliation';
