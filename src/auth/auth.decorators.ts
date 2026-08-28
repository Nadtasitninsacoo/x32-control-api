import {
  ExecutionContext,
  SetMetadata,
  createParamDecorator,
} from '@nestjs/common';
import { Role } from './user.store.js';

export const IS_PUBLIC = 'auth:public';
export const REQUIRED_ROLE = 'auth:role';

/** No token needed: login, health, the documentation. */
export const Public = (): MethodDecorator & ClassDecorator =>
  SetMetadata(IS_PUBLIC, true);

/**
 * The minimum role for this route.
 *
 * Without it the role is inferred from the HTTP method — reads need
 * `observer`, writes need `engineer` — which is the right default for a mixing
 * API and means a new endpoint is never accidentally left open. Routes that
 * break that pattern (a POST that only calculates, user management) say so.
 */
export const Roles = (role: Role): MethodDecorator & ClassDecorator =>
  SetMetadata(REQUIRED_ROLE, role);

export interface Principal {
  readonly id: string;
  readonly username: string;
  readonly role: Role;
  readonly displayName?: string | null;
  /** True when authentication is switched off and this is the stand-in. */
  readonly anonymous?: boolean;
}

/** The authenticated user, as attached by the guard. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal | undefined =>
    context.switchToHttp().getRequest<{ user?: Principal }>().user,
);
