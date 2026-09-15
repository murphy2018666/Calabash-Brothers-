import { Global, Module, Provider } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { EventEmitterModule, EventEmitter2 } from '@nestjs/event-emitter';
import { SPI_TOKENS } from '@aegisci/core/spi';
import type { AuthorizeResult, DomainEvent } from '@aegisci/shared/types';
import {
  AUDIT_WORM_SINK,
  type AuditWormSink,
} from '@aegisci/domain/audit';
import {
  POLICY_DECISION_CACHE,
  type PolicyDecisionCache,
} from '@aegisci/domain/policy/decision';
import {
  CREDENTIAL_JTI_REGISTRY,
  type CredentialJtiRegistry,
  type JtiRegistryEntry,
} from '@aegisci/domain/policy/credential';
import {
  AGENT_TOKEN_REGISTRY,
  type AgentTokenRegistry,
  type AgentTokenRegistryEntry,
} from '@aegisci/domain/identity';
import { POLICY_SIMULATOR } from '@aegisci/domain/skill';
import {
  BLACKBOARD_REPOSITORY,
  type BlackboardRepository,
  OR_EVENT_PUBLISHER,
  type OrEventPublisher,
} from '@aegisci/domain/orchestration';
import {
  TASK_PLAN_REPOSITORY,
  type TaskPlanRepository,
} from '@aegisci/domain/orchestration';
import type { BlackboardSession } from '@aegisci/domain/orchestration';
import type { TaskPlan } from '@aegisci/domain/orchestration';

import { NoopTraceExporter } from './noop-trace-exporter';
import { EnvFileSecretProvider } from './env-file-secret-provider';
import { EmbeddedPolicyEngine } from './embedded-policy-engine';
import { WormTraceExporter } from './worm-trace-exporter';
import { OpaPolicyEngine } from './opa-policy-engine';
import { VaultSecretProvider } from './vault-secret-provider';
import { GvisorSandboxRuntime } from './gvisor-sandbox-runtime';
import { DeploymentProfileService } from '../services/deployment-profile.service';
import type { DeploymentMode } from '../services/deployment-mode';
import { InMemoryAgentProvider } from './in-memory-agent-provider';
import { InMemoryToolProvider } from './in-memory-tool-provider';
import { InMemorySkillRegistry } from './in-memory-skill-registry';
import { StubModelGateway } from './stub-model-gateway';
import { InMemoryRunRepository } from './in-memory-run-repository';
import { InMemoryTaskPlanRepository } from './in-memory-task-plan-repository';
import { PgTaskPlanRepository } from './pg-task-plan-repository';
import { PgCredentialJtiRegistry } from './pg-credential-jti-registry';
import { PgAgentTokenRegistry } from './pg-agent-token-registry';
import { OrchestratorBridgeService } from './orchestrator-bridge.service';
import { InMemoryGateRepository } from './in-memory-gate-repository';
import { InMemoryNatsEventBus } from './in-memory-nats-event-bus';
import { InMemoryConnectionGateway } from './in-memory-connection-gateway';
import { DaggerExecBackend } from './d5-dagger-exec-backend';
import { GoRunnerExecBackend } from './d5-gorunner-exec-backend';
import { ExternalCIBridge } from './d5-external-ci-bridge';
import { CostMetricService } from './g3-cost-metric-service';
import { Agent0TrialFramework } from './j2-agent0-runner';
import { PIPELINE_TOKENS } from '@aegisci/domain/pipeline';
import { isMockMode, shouldUseMockDefaults } from '../mocks';

/**
 * SpiDefaultsModule —— 控制面默认 SPI 实现 + 域端口桩实现装配（DES-13 / ADD §7）。
 *
 * 全局模块：注册 7 个 SPI 接口的默认实现，使用 @aegisci/core/spi 的 Symbol 令牌：
 *  1. NoopTraceExporter     (TRACE_EXPORTER)
 *  2. EnvFileSecretProvider (SECRET_PROVIDER)
 *  3. EmbeddedPolicyEngine  (POLICY_ENGINE)
 *  4. InMemoryAgentProvider (AGENT_PROVIDER)
 *  5. InMemoryToolProvider  (TOOL_PROVIDER)
 *  6. InMemorySkillRegistry(SKILL_REGISTRY)
 *  7. StubModelGateway      (MODEL_GATEWAY)
 *
 * 另注册域端口默认实现以使控制面可独立启动（实现可替换，控制点在内核 FR-M7-02）：
 *  - AUDIT_WORM_SINK / POLICY_DECISION_CACHE / CREDENTIAL_JTI_REGISTRY
 *  - AGENT_TOKEN_REGISTRY / POLICY_SIMULATOR（复用 EmbeddedPolicyEngine.simulate）
 */
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 域端口默认实现（内存桩，进程重启即清空）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class InMemoryAuditWormSink implements AuditWormSink {
  private readonly objects = new Map<string, string>();
  async appendObject(objectKey: string, canonicalBody: string): Promise<void> {
    this.objects.set(objectKey, canonicalBody);
  }
}

class InMemoryDecisionCache implements PolicyDecisionCache {
  private readonly store = new Map<
    string,
    { value: AuthorizeResult; expiresAt: number }
  >();
  async get(key: string): Promise<AuthorizeResult | null> {
    const hit = this.store.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expiresAt) {
      this.store.delete(key);
      return null;
    }
    return hit.value;
  }
  async set(
    key: string,
    value: AuthorizeResult,
    ttlSeconds: number,
  ): Promise<void> {
    this.store.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }
}

type StoredJtiEntry = Omit<JtiRegistryEntry, 'jti' | 'revoked'> & {
  revoked: boolean;
};

class InMemoryJtiRegistry implements CredentialJtiRegistry {
  private readonly entries = new Map<string, StoredJtiEntry>();
  async register(
    jti: string,
    entry: Omit<JtiRegistryEntry, 'jti' | 'revoked'>,
    ttlSeconds: number,
  ): Promise<void> {
    void ttlSeconds;
    this.entries.set(jti, { ...entry, revoked: false });
  }
  async revoke(jti: string): Promise<void> {
    const existing = this.entries.get(jti);
    if (existing) {
      this.entries.set(jti, { ...existing, revoked: true });
    }
  }
  async listByPrincipal(principal: string): Promise<string[]> {
    const out: string[] = [];
    for (const [jti, entry] of this.entries) {
      if (entry.principal === principal && !entry.revoked) {
        out.push(jti);
      }
    }
    return out;
  }
  async isRevoked(jti: string): Promise<boolean> {
    return this.entries.get(jti)?.revoked ?? false;
  }
}

class InMemoryAgentTokenRegistry implements AgentTokenRegistry {
  private readonly entries = new Map<
    string,
    AgentTokenRegistryEntry & { revoked: boolean }
  >();
  async register(
    jti: string,
    entry: AgentTokenRegistryEntry,
    ttlSeconds: number,
  ): Promise<void> {
    void ttlSeconds;
    this.entries.set(jti, { ...entry, revoked: false });
  }
  async revoke(jti: string): Promise<void> {
    const existing = this.entries.get(jti);
    if (existing) {
      this.entries.set(jti, { ...existing, revoked: true });
    }
  }
  async listByAgent(agentId: string): Promise<string[]> {
    const out: string[] = [];
    for (const [jti, entry] of this.entries) {
      if (entry.agentId === agentId && !entry.revoked) {
        out.push(jti);
      }
    }
    return out;
  }
  async isRevoked(jti: string): Promise<boolean> {
    // S2 联调：TokenService.verify() 优先走 O(1) isRevoked；
    // 缺省时回退 listByAgent（O(n)），此实现提供 O(1) 路径。
    return this.entries.get(jti)?.revoked ?? false;
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// OR 域端口默认实现（内存桩，进程重启即清空）
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

class InMemoryBlackboardRepository implements BlackboardRepository {
  private readonly store = new Map<string, BlackboardSession>();
  private readonly byRun = new Map<string, string>();

  async save(session: BlackboardSession): Promise<void> {
    this.store.set(session.blackboardSessionId, session);
    // 从 session 中获取 runId 需要 toString 或属性访问；使用 JSON 序列化兜底
    const runId = (session as unknown as { runId: string }).runId;
    if (runId) this.byRun.set(runId, session.blackboardSessionId);
  }

  async load(id: string): Promise<BlackboardSession | null> {
    return this.store.get(id) ?? null;
  }

  async loadByRun(runId: string): Promise<BlackboardSession | null> {
    const id = this.byRun.get(runId);
    if (!id) return null;
    return this.store.get(id) ?? null;
  }
}

class EventEmitter2OrPublisher implements OrEventPublisher {
  constructor(private readonly emitter: EventEmitter2) {}

  publish<T>(event: DomainEvent<T>): Promise<void> | void {
    this.emitter.emit(event.eventType, event);
  }
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 模块装配
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

const SPI_DEFAULT_PROVIDERS = [
  // 默认实现（按 DeploymentMode 动态选择）
  NoopTraceExporter,
  EnvFileSecretProvider,
  EmbeddedPolicyEngine,
  WormTraceExporter,
  OpaPolicyEngine,
  VaultSecretProvider,
  InMemoryAgentProvider,
  InMemoryToolProvider,
  InMemorySkillRegistry,
  StubModelGateway,
  GvisorSandboxRuntime,
  DeploymentProfileService,
  // SPI 令牌 → 默认实现别名（单一实例，根据当前 DeploymentMode 动态映射）
  {
    provide: SPI_TOKENS.TRACE_EXPORTER,
    useFactory: () => {
      if (shouldUseMockDefaults()) return new NoopTraceExporter(); // test env: always noop
      const mode = (process.env.AEGISCI_DEPLOYMENT_MODE as DeploymentMode) ?? 'standard';
      if (mode === 'hardened') return new WormTraceExporter();
      return new NoopTraceExporter();
    },
  },
  {
    provide: SPI_TOKENS.SECRET_PROVIDER,
    useFactory: () => {
      if (isMockMode()) return new EnvFileSecretProvider(); // test env: always env-file
      const mode = (process.env.AEGISCI_DEPLOYMENT_MODE as DeploymentMode) ?? 'standard';
      if (mode === 'minimal') return new EnvFileSecretProvider();
      return new VaultSecretProvider();
    },
  },
  {
    provide: SPI_TOKENS.POLICY_ENGINE,
    useFactory: () => {
      if (shouldUseMockDefaults()) return new EmbeddedPolicyEngine(); // test env: always embedded
      const mode = (process.env.AEGISCI_DEPLOYMENT_MODE as DeploymentMode) ?? 'standard';
      if (mode === 'hardened') return new OpaPolicyEngine();
      return new EmbeddedPolicyEngine();
    },
  },
  { provide: SPI_TOKENS.AGENT_PROVIDER, useExisting: InMemoryAgentProvider },
  { provide: SPI_TOKENS.TOOL_PROVIDER, useExisting: InMemoryToolProvider },
  { provide: SPI_TOKENS.SKILL_REGISTRY, useExisting: InMemorySkillRegistry },
  { provide: SPI_TOKENS.MODEL_GATEWAY, useExisting: StubModelGateway },
  // 域端口默认实现（使控制面可独立启动）
  { provide: AUDIT_WORM_SINK, useFactory: () => new InMemoryAuditWormSink() },
  {
    provide: POLICY_DECISION_CACHE,
    useFactory: () => new InMemoryDecisionCache(),
  },
  {
    provide: CREDENTIAL_JTI_REGISTRY,
    useFactory: (eventEmitter: EventEmitter2) => {
      const pgUrl = process.env.AEGISCI_PG_URL;
      if (pgUrl) {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: pgUrl });
        const registry = new PgCredentialJtiRegistry(
          (text, params) => pool.query(text, params),
          eventEmitter,
        );
        registry.ensureSchema().catch((e: unknown) =>
          console.error('[SpiDefaultsModule] credential_jtis ensureSchema failed:', e),
        );
        registry.loadRevoked().catch((e: unknown) =>
          console.error('[SpiDefaultsModule] loadRevoked failed:', e),
        );
        return registry;
      }
      return new InMemoryJtiRegistry();
    },
    inject: [EventEmitter2],
  },
  {
    provide: AGENT_TOKEN_REGISTRY,
    useFactory: () => {
      const pgUrl = process.env.AEGISCI_PG_URL;
      if (pgUrl) {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: pgUrl });
        const registry = new PgAgentTokenRegistry((text, params) =>
          pool.query(text, params),
        );
        registry.ensureSchema().catch((e: unknown) =>
          console.error('[SpiDefaultsModule] revoked_jtis ensureSchema failed:', e),
        );
        registry.loadRevoked().catch((e: unknown) =>
          console.error('[SpiDefaultsModule] loadRevoked failed:', e),
        );
        return registry;
      }
      return new InMemoryAgentTokenRegistry();
    },
  },
  // Skill 评审的策略模拟器复用 EmbeddedPolicyEngine.simulate（结构子集）
  { provide: POLICY_SIMULATOR, useExisting: EmbeddedPolicyEngine },
  // OR 域端口默认实现（使控制面可独立启动）
  { provide: BLACKBOARD_REPOSITORY, useFactory: () => new InMemoryBlackboardRepository() },
  {
    provide: TASK_PLAN_REPOSITORY,
    useFactory: () => {
      const pgUrl = process.env.AEGISCI_PG_URL;
      if (pgUrl) {
        const { Pool } = require('pg');
        const pool = new Pool({ connectionString: pgUrl });
        const repo = new PgTaskPlanRepository((text, params) => pool.query(text, params));
        repo.ensureSchema().catch((e: unknown) =>
          console.error('[SpiDefaultsModule] ensureSchema failed:', e),
        );
        return repo;
      }
      return new InMemoryTaskPlanRepository();
    },
  },
  {
    provide: OR_EVENT_PUBLISHER,
    useFactory: () => new EventEmitter2OrPublisher(new EventEmitter2()),
  },
  // PL 域 Run 仓储端口默认实现（内存桩，进程重启即清空）
  InMemoryRunRepository,
  { provide: PIPELINE_TOKENS.RUN_REPOSITORY, useExisting: InMemoryRunRepository },
  // PL 域 Gate / EventBus / ConnectionGateway 端口默认实现
  InMemoryGateRepository,
  { provide: PIPELINE_TOKENS.GATE_REPOSITORY, useExisting: InMemoryGateRepository },
  InMemoryNatsEventBus,
  { provide: PIPELINE_TOKENS.EVENT_BUS, useExisting: InMemoryNatsEventBus },
  InMemoryConnectionGateway,
  { provide: PIPELINE_TOKENS.CONNECTION_GATEWAY, useExisting: InMemoryConnectionGateway },
];

// 导出令牌（@Global 模块对外可见的依赖项）—— 类与 Symbol 令牌。
const SPI_DEFAULT_EXPORTS = [
  NoopTraceExporter,
  EnvFileSecretProvider,
  EmbeddedPolicyEngine,
  WormTraceExporter,
  OpaPolicyEngine,
  VaultSecretProvider,
  GvisorSandboxRuntime,
  InMemoryAgentProvider,
  InMemoryToolProvider,
  InMemorySkillRegistry,
  StubModelGateway,
  DeploymentProfileService,
  SPI_TOKENS.TRACE_EXPORTER,
  SPI_TOKENS.SECRET_PROVIDER,
  SPI_TOKENS.POLICY_ENGINE,
  SPI_TOKENS.AGENT_PROVIDER,
  SPI_TOKENS.TOOL_PROVIDER,
  SPI_TOKENS.SKILL_REGISTRY,
  SPI_TOKENS.MODEL_GATEWAY,
  AUDIT_WORM_SINK,
  POLICY_DECISION_CACHE,
  CREDENTIAL_JTI_REGISTRY,
  AGENT_TOKEN_REGISTRY,
  POLICY_SIMULATOR,
  BLACKBOARD_REPOSITORY,
  TASK_PLAN_REPOSITORY,
  OR_EVENT_PUBLISHER,
  InMemoryRunRepository,
  PIPELINE_TOKENS.RUN_REPOSITORY,
  InMemoryGateRepository,
  PIPELINE_TOKENS.GATE_REPOSITORY,
  InMemoryNatsEventBus,
  PIPELINE_TOKENS.EVENT_BUS,
  InMemoryConnectionGateway,
  PIPELINE_TOKENS.CONNECTION_GATEWAY,
  // D5
  DaggerExecBackend,
  GoRunnerExecBackend,
  ExternalCIBridge,
  // G3
  CostMetricService,
  // J2
  Agent0TrialFramework,
];

@Global()
@Module({
  imports: [EventEmitterModule.forRoot(), ConfigModule.forFeature(() => ({}))],
  providers: [
    ...SPI_DEFAULT_PROVIDERS,
    // D5 执行后端（导出但需要显式注册为 provider）
    DaggerExecBackend,
    GoRunnerExecBackend,
    ExternalCIBridge,
    // G3 / J2
    CostMetricService,
    Agent0TrialFramework,
    // ConfigService 桩（供需要注入的类使用）—— 使用 ConfigService 类本身作为 token
    {
      provide: ConfigService,
      useValue: { get: (key: string) => process.env[key] },
    } as unknown as Provider,
  ],
  exports: SPI_DEFAULT_EXPORTS,
})
export class SpiDefaultsModule {}
