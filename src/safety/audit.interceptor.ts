import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable, tap } from 'rxjs';
import { Principal } from '../auth/auth.decorators.js';
import { SafetyService } from './safety.service.js';

/** Field names whose values must never reach the audit log. */
const SECRETS = ['password', 'token', 'accesstoken', 'secret', 'confirm'];

/** Fields that are legitimately enormous — a scene file, a measurement. */
const BULKY = ['measurement', 'content', 'values'];

/**
 * Records every state-changing request: who, what, which console, and enough
 * of the payload to recognise it later.
 *
 * Reads are not recorded. An audit trail that logs every meter poll is one
 * nobody reads, and the question this exists to answer — "who changed that,
 * and when" — is only ever about writes.
 */
@Injectable()
export class AuditInterceptor implements NestInterceptor {
  constructor(private readonly safety: SafetyService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();

    const request = context.switchToHttp().getRequest<{
      method: string;
      originalUrl?: string;
      url: string;
      params?: Record<string, string>;
      body?: unknown;
      user?: Principal;
    }>();

    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method))
      return next.handle();

    const action = `${request.method} ${stripQuery(request.originalUrl ?? request.url)}`;
    const consoleId = request.params?.consoleId ?? request.params?.id;
    const user = request.user?.username;
    const detail = summarise(request.body);

    return next.handle().pipe(
      tap({
        next: (result) => {
          void this.safety.record({
            user,
            action,
            consoleId,
            detail: { ...detail, outcome: outcomeOf(result) },
          });
        },
        error: (error: unknown) => {
          void this.safety.record({
            user,
            action,
            consoleId,
            detail: {
              ...detail,
              outcome: 'failed',
              error: error instanceof Error ? error.message : String(error),
            },
          });
        },
      }),
    );
  }
}

function stripQuery(url: string): string {
  const index = url.indexOf('?');
  return index === -1 ? url : url.slice(0, index);
}

/** Enough of the request to recognise it, with secrets and bulk removed. */
function summarise(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object') return {};
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    const name = key.toLowerCase();
    if (SECRETS.includes(name)) {
      out[key] = '[redacted]';
    } else if (BULKY.includes(name)) {
      out[key] =
        typeof value === 'string' ? `[${value.length} chars]` : '[omitted]';
    } else if (value !== null && typeof value === 'object') {
      out[key] = JSON.stringify(value).slice(0, 500);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** The part of a response worth keeping: what actually changed. */
function outcomeOf(result: unknown): unknown {
  if (!result || typeof result !== 'object') return 'ok';
  const record = result as Record<string, unknown>;

  if (typeof record.changed === 'number') {
    return { changed: record.changed, messages: record.messages };
  }
  if (record.apply && typeof record.apply === 'object') {
    const apply = record.apply as Record<string, unknown>;
    return { changed: apply.changed, messages: apply.messages };
  }
  if (typeof record.id === 'string') return { id: record.id };
  return 'ok';
}
