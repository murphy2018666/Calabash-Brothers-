import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { AuditWormService, type AuditSealedResult } from '@aegisci/domain/audit';
import type { AuditEnvelope } from '@aegisci/shared/types';
import { InvariantViolationError } from './invariant-violation.error';

/**
 * AgentActionAuditGuard —— 内核不变量 2：EVERY_AGENT_ACTION_AUDITED
 * （所有 Agent 动作必入 WORM 审计，ADD §4 / FR-M7-01）。
 *
 * 作为 NestJS Interceptor 包裹每一次 Agent 动作：
 * - 动作执行后必须 verify 该动作的 WORM seal() 已完成，否则抛
 *   InvariantViolationError（证据链不中断）。
 * - WORM 不可关闭、不可替换为可删存储（DES-8）。
 * - 违反即 CI 守护测试挂红（AG-4 审计链套件）。
 */
@Injectable()
export class AgentActionAuditGuard implements NestInterceptor {
  private readonly sealed = new Set<string>(); // actionKey

  constructor(private readonly auditWorm: AuditWormService) {}

  /** 为 Agent 动作固化审计信封 —— 必须为每个动作调用。 */
  async seal(actionKey: string, envelope: AuditEnvelope): Promise<AuditSealedResult> {
    const result = await this.auditWorm.seal(envelope);
    this.sealed.add(actionKey);
    return result;
  }

  /** 当固化在 guard 外部完成时，仅登记已固化动作。 */
  recordSeal(actionKey: string): void {
    this.sealed.add(actionKey);
  }

  /** 包裹 Agent 动作 —— 执行后校验 WORM seal() 已被调用。 */
  async runAction<T>(actionKey: string, action: () => Promise<T>): Promise<T> {
    const result = await action();
    if (!this.sealed.has(actionKey)) {
      throw new InvariantViolationError(
        'EVERY_AGENT_ACTION_AUDITED',
        `agent action not sealed in WORM audit: ${actionKey}`,
      );
    }
    return result;
  }

  /** NestJS 路由拦截器：拦截 Agent 动作路由，未固化即挂红。 */
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ body?: { actionKey?: string } }>();
    const actionKey = req?.body?.actionKey;
    if (actionKey && !this.sealed.has(actionKey)) {
      throw new InvariantViolationError(
        'EVERY_AGENT_ACTION_AUDITED',
        `route agent action not sealed: ${actionKey}`,
      );
    }
    return next.handle();
  }
}
