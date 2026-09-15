import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import { BlackboardService } from '@aegisci/domain/orchestration';
import { InvariantViolationError } from './invariant-violation.error';

/**
 * BlackboardCommunicationGuard —— 内核不变量 3：AGENT_COMMUNICATION_VIA_BLACKBOARD
 * （Agent 间通信必走 Blackboard，ADD §4 / FR-M7-01 / DES-13.9）。
 *
 * 禁止 Agent 直接调用/读取其他 Agent 的上下文；跨 Agent 信息交换只走黑板
 * （M1 黑板模式）。direct attemptDirectAgentCall() 恒抛 InvariantViolationError；
 * communicateViaBlackboard() 为唯一允许的跨 Agent 通信通道。
 * 违反即 CI 守护测试挂红。
 */
type AppendBlackboardCmd = Parameters<BlackboardService['append']>[1];

@Injectable()
export class BlackboardCommunicationGuard implements NestInterceptor {
  constructor(private readonly blackboard: BlackboardService) {}

  /** 直接 Agent→Agent 通信 —— 恒被阻断（不变量 3）。 */
  async attemptDirectAgentCall(
    fromAgentId: string,
    toAgentId: string,
    message: unknown,
  ): Promise<never> {
    void message;
    throw new InvariantViolationError(
      'AGENT_COMMUNICATION_VIA_BLACKBOARD',
      `direct agent-to-agent communication blocked: ${fromAgentId} -> ${toAgentId}; agents must communicate via Blackboard`,
    );
  }

  /** 经黑板通信 —— 唯一允许的跨 Agent 通道。 */
  async communicateViaBlackboard(
    callerAgentId: string,
    cmd: AppendBlackboardCmd,
    tenantId: string,
    traceSpanId: string,
  ) {
    return this.blackboard.append(callerAgentId, cmd, tenantId, traceSpanId);
  }

  /** 断言通信路径走黑板 —— 非黑板即挂红。 */
  assertViaBlackboard(
    viaBlackboard: boolean,
    fromAgentId: string,
    toAgentId?: string,
  ): void {
    if (!viaBlackboard) {
      throw new InvariantViolationError(
        'AGENT_COMMUNICATION_VIA_BLACKBOARD',
        `direct agent communication blocked: ${fromAgentId} -> ${toAgentId ?? 'peer'}; route via Blackboard`,
      );
    }
  }

  /** NestJS 路由拦截器：默认放行（黑板通信由专用入口校验）。 */
  intercept(_context: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle();
  }
}
