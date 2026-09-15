import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  Logger,
  SetMetadata,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import {
  IdentityService,
  type PrincipalRecord,
  TokenService,
  TokenVerificationError,
  type VerifiedAgentToken,
} from '@aegisci/domain/identity';

/**
 * AuthGuard —— 控制面统一鉴权守卫（DES-3 ID 上下文 / S2 深化）。
 *
 * 职责（ADD §4 内核不变量 0：NO_UNAUTHENTICATED_ACCESS）：
 * - 从 Authorization: Bearer <token> 提取令牌
 * - 通过 TokenService.verify() 校验令牌（解码 + 验签 + 验过期 + 验 JTI 吊销）
 * - 通过 IdentityService.findByAgentCard() 反查 Principal 并注入到 request.principal
 * - 缺失/无效/过期/已吊销 → 401 Unauthorized
 * - 角色不足 → 403 Forbidden（可选；需配合 @Roles() 装饰器使用）
 *
 * 不变量：
 * - 任何非公开路由的请求必须持有已校验的 Principal
 * - Principal 一旦注入即冻结（不可被下游中间件修改）
 * - 校验失败的错误信息不得泄露内部状态（如 agentId 真值、JTI 真值）
 *
 * 路由级使用：
 *   @UseGuards(AuthGuard)
 *   @Roles('agent:reviewer')
 *   @Controller()
 *
 * 全局使用（推荐）：
 *   @Module({
 *     providers: [
 *       { provide: APP_GUARD, useClass: AuthGuard },
 *     ],
 *   })
 */
export const ROLES_KEY = 'aegisci:roles';
export const PUBLIC_KEY = 'aegisci:public';

/**
 * @Roles(...roles) —— 路由所需角色（用于 403 检查）。
 * 缺失装饰器 = 不做角色检查（仅校验 Principal 已注入）。
 */
export const Roles = (...roles: string[]) => SetMetadata(ROLES_KEY, roles);

/**
 * @Public() —— 标记路由为公开（跳过鉴权；如 /health）。
 */
export const Public = () => SetMetadata(PUBLIC_KEY, true);

/**
 * PrincipalRequest —— 注入了 Principal 的 Express 请求形状。
 */
export interface PrincipalRequest extends Request {
  principal?: Readonly<PrincipalRecord>;
  verifiedToken?: Readonly<VerifiedAgentToken>;
}

@Injectable()
export class AuthGuard implements CanActivate {
  private readonly logger = new Logger(AuthGuard.name);

  constructor(
    private readonly reflector: Reflector,
    private readonly tokens: TokenService,
    private readonly identity: IdentityService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic) {
      return true; // 公开路由跳过鉴权
    }

    const req = context.switchToHttp().getRequest<PrincipalRequest>();
    const authHeader = req.headers['authorization'] as string | undefined;
    const token = this.extractBearerToken(authHeader);

    if (!token) {
      this.logger.warn(
        `missing bearer token: ${req.method} ${req.url} from ${req.ip}`,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'invalid_request',
        error_description: 'Authorization Bearer token is required',
      });
    }

    // 校验令牌（解码 + 验签 + 验过期 + 验 JTI 吊销）
    let verified: VerifiedAgentToken;
    try {
      verified = await this.tokens.verify(token);
    } catch (err) {
      const reason =
        err instanceof TokenVerificationError
          ? err.reason
          : 'invalid_token';
      this.logger.warn(
        `token verification failed (${reason}): ${req.method} ${req.url}`,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'invalid_token',
        error_description: `access token verification failed: ${reason}`,
      });
    }

    // 反查 Principal 并注入到 request
    const principal = await this.identity.findByAgentCard(verified.agentId);
    if (!principal) {
      this.logger.warn(
        `principal not found for agentId=${verified.agentId} (jti=${verified.jti})`,
      );
      throw new UnauthorizedException({
        statusCode: 401,
        error: 'invalid_token',
        error_description: 'principal not found for the given token',
      });
    }

    // 冻结注入防止下游修改（与"主体不可动态扩权"不变量对齐）
    req.principal = Object.freeze({ ...principal });
    req.verifiedToken = Object.freeze({ ...verified });

    // 角色检查（可选；缺失装饰器 = 不检查）
    const requiredRoles = this.reflector.getAllAndOverride<string[]>(
      ROLES_KEY,
      [context.getHandler(), context.getClass()],
    );
    if (requiredRoles && requiredRoles.length > 0) {
      const hasRole = requiredRoles.some((r) => principal.roles.includes(r));
      if (!hasRole) {
        this.logger.warn(
          `insufficient roles for principal=${principal.id} (need=[${requiredRoles.join(',')}], have=[${principal.roles.join(',')}])`,
        );
        throw new ForbiddenException({
          statusCode: 403,
          error: 'insufficient_role',
          error_description: 'principal does not have required roles',
        });
      }
    }

    return true;
  }

  /** 从 Authorization 头解析 Bearer 令牌。 */
  private extractBearerToken(authHeader: string | undefined): string | null {
    if (!authHeader) return null;
    const lower = authHeader.toLowerCase();
    if (!lower.startsWith('bearer ')) return null;
    const token = authHeader.slice(7).trim();
    return token || null;
  }
}
