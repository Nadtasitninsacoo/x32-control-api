import {
  CanActivate,
  ExecutionContext,
  Injectable,
  SetMetadata,
} from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SafetyService } from './safety.service.js';

export const ALLOWED_WHEN_READ_ONLY = 'safety:allowed-when-read-only';

/**
 * Marks a route that still works while read-only mode is on.
 *
 * Panic is the reason this exists: read-only is there to prevent an accident,
 * and panic is there to end one. Logging in and reading state are the others.
 */
export const AllowedWhenReadOnly = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOWED_WHEN_READ_ONLY, true);

/**
 * Refuses anything that would change the console while read-only is on.
 *
 * Answers 423 Locked rather than 403: the request was allowed, the system is
 * deliberately not accepting it right now, and the difference matters to
 * whoever is reading the error at the back of a dark room.
 */
@Injectable()
export class ReadOnlyGuard implements CanActivate {
  constructor(
    private readonly safety: SafetyService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    if (!this.safety.readOnly) return true;

    const request = context.switchToHttp().getRequest<{ method: string }>();
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method)) return true;

    const allowed = this.reflector.getAllAndOverride<boolean>(
      ALLOWED_WHEN_READ_ONLY,
      [context.getHandler(), context.getClass()],
    );
    if (allowed) return true;

    throw new HttpException(
      {
        statusCode: HttpStatus.LOCKED,
        error: 'Locked',
        message:
          'this API is in read-only mode, so nothing is being sent to the console. ' +
          'Lift it with POST /api/safety/read-only.',
      },
      HttpStatus.LOCKED,
    );
  }
}
