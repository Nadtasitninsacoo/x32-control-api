import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ANONYMOUS, AuthService } from './auth.service.js';
import { IS_PUBLIC, Principal, REQUIRED_ROLE } from './auth.decorators.js';
import { ROLE_RANK, Role } from './user.store.js';

interface AuthenticatedRequest {
  method: string;
  user?: Principal;
  headers: Record<string, string | string[] | undefined>;
}

/**
 * One guard for both halves of the question: who is this, and may they do it.
 *
 * The role a route needs is *inferred from its HTTP method* unless it says
 * otherwise — reads need `observer`, writes need `engineer`. That way a new
 * endpoint added next month is protected by default rather than open by
 * default, which is the failure mode that matters here: this API moves faders
 * in a room full of people.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!this.auth.enabled) {
      // Authentication off: everything runs as a clearly-labelled stand-in, so
      // the audit log still has something to attribute the change to.
      request.user = ANONYMOUS;
      return true;
    }

    if (isPublic) return true;

    const token = bearerToken(request);
    if (!token)
      throw new UnauthorizedException('this endpoint needs a bearer token');

    const principal = await this.auth.verify(token);
    request.user = principal;

    const required = this.requiredRole(context, request.method);
    if (ROLE_RANK[principal.role] < ROLE_RANK[required]) {
      throw new ForbiddenException(
        `this needs the "${required}" role; "${principal.username}" is ${principal.role}`,
      );
    }
    return true;
  }

  private requiredRole(context: ExecutionContext, method: string): Role {
    const explicit = this.reflector.getAllAndOverride<Role>(REQUIRED_ROLE, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (explicit) return explicit;
    return method === 'GET' || method === 'HEAD' || method === 'OPTIONS'
      ? 'observer'
      : 'engineer';
  }
}

function bearerToken(request: AuthenticatedRequest): string | undefined {
  const header = request.headers.authorization;
  const value = Array.isArray(header) ? header[0] : header;
  if (!value) return undefined;
  const [scheme, token] = value.split(' ');
  return scheme?.toLowerCase() === 'bearer' && token ? token : undefined;
}
