import {
  CallHandler,
  ExecutionContext,
  Inject,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { SPI_TOKENS, type PolicyEngineSPI, type ToolProvider } from '@aegisci/core/spi';
import type {
  AuthorizeRequest,
  AuthorizeResult,
  ToolCallRequest,
  ToolCallResult,
} from '@aegisci/shared/types';
import { InvariantViolationError } from './invariant-violation.error';

/**
 * ToolCallAuthorizeGuard —— 内核不变量 1：EVERY_TOOL_CALL_AUTHORIZE
 * （每次 Agent 工具调用必经 Policy Engine 裁决，ADD §4 / FR-M7-01）。
 *
 * 作为 NestJS Interceptor 包裹每一次 ToolProvider.execute() 调用：
 * - 必须先经 authorize()（Policy 裁决并被记录）才能 execute()。
 * - DENY 不记录授权，execute() 仍抛 InvariantViolationError（fail-closed）。
 * - 违反即 CI 守护测试挂红（AG-3 权限链套件）。
 */
@Injectable()
export class ToolCallAuthorizeGuard implements NestInterceptor {
  private readonly authorized = new Map<string, string>(); // key → evidenceId

  constructor(
    @Inject(SPI_TOKENS.POLICY_ENGINE) private readonly policy: PolicyEngineSPI,
    @Inject(SPI_TOKENS.TOOL_PROVIDER) private readonly tool: ToolProvider,
  ) {}

  /** Step 1：策略裁决 —— 必须在 execute() 之前调用；允许时记录 evidenceId。 */
  async authorize(req: AuthorizeRequest): Promise<AuthorizeResult> {
    const result = await this.policy.authorize(req);
    if (result.decision !== 'DENY') {
      this.authorized.set(this.authKey(req), result.evidence.evidenceId);
    }
    return result;
  }

  /** Step 2：执行工具 —— 未先 authorize（或被 DENY）则抛 InvariantViolationError。 */
  async execute(req: ToolCallRequest): Promise<ToolCallResult> {
    const key = this.toolKey(req);
    if (!this.authorized.has(key)) {
      throw new InvariantViolationError(
        'EVERY_TOOL_CALL_AUTHORIZE',
        `tool call not authorized before execution: tool=${req.toolName} action=${req.action} run=${req.runId}`,
      );
    }
    return this.tool.execute(req);
  }

  /** 组合：先裁决后执行（DENY 即抛 InvariantViolationError）。 */
  async authorizeAndExecute(
    authReq: AuthorizeRequest,
    toolReq: ToolCallRequest,
  ): Promise<ToolCallResult> {
    const result = await this.authorize(authReq);
    if (result.decision === 'DENY') {
      throw new InvariantViolationError(
        'EVERY_TOOL_CALL_AUTHORIZE',
        `policy denied tool call: ${result.evidence.reason}`,
      );
    }
    return this.execute(toolReq);
  }

  /** NestJS 路由拦截器：拦截触发工具调用的 HTTP 路由，未授权即挂红。 */
  intercept(
    context: ExecutionContext,
    next: CallHandler,
  ): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{ body?: ToolCallRequest }>();
    const toolReq = req?.body;
    if (toolReq && !this.authorized.has(this.toolKey(toolReq))) {
      throw new InvariantViolationError(
        'EVERY_TOOL_CALL_AUTHORIZE',
        `route tool call not authorized: tool=${toolReq.toolName} action=${toolReq.action}`,
      );
    }
    return next.handle();
  }

  private authKey(req: AuthorizeRequest): string {
    return `${req.principal.id}|${req.action}|${req.resource}`;
  }

  private toolKey(req: ToolCallRequest): string {
    return `${req.agentId}|${req.action}|${req.resource}`;
  }
}
