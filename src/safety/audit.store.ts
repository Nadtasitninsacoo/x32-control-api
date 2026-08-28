import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

/**
 * The record of what this API did, and who asked for it.
 *
 * On a stage, "who turned that up" is a question with consequences, and the
 * honest answer has to survive the show. Same two-implementation shape as the
 * other stores: PostgreSQL when `DATABASE_URL` is set, memory otherwise — and
 * when it is memory, the safety status says so, because an audit trail nobody
 * can read back later is worth knowing about in advance.
 */

export interface AuditEntryRecord {
  id: string;
  at: Date;
  user?: string | null;
  action: string;
  consoleId?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface AuditQuery {
  readonly limit?: number;
  readonly consoleId?: string;
  readonly user?: string;
}

export interface AuditStore {
  readonly kind: 'memory' | 'postgres';
  record(entry: Omit<AuditEntryRecord, 'id' | 'at'>): Promise<void>;
  list(query?: AuditQuery): Promise<AuditEntryRecord[]>;
}

export const AUDIT_STORE = Symbol('AUDIT_STORE');

/** How many entries the in-memory ring keeps before dropping the oldest. */
export const MEMORY_AUDIT_LIMIT = 5000;

@Injectable()
export class MemoryAuditStore implements AuditStore {
  readonly kind = 'memory' as const;
  private readonly entries: AuditEntryRecord[] = [];

  async record(entry: Omit<AuditEntryRecord, 'id' | 'at'>): Promise<void> {
    this.entries.push({ ...entry, id: randomUUID(), at: new Date() });
    if (this.entries.length > MEMORY_AUDIT_LIMIT) {
      this.entries.splice(0, this.entries.length - MEMORY_AUDIT_LIMIT);
    }
  }

  async list(query: AuditQuery = {}): Promise<AuditEntryRecord[]> {
    return this.entries
      .filter(
        (entry) => !query.consoleId || entry.consoleId === query.consoleId,
      )
      .filter((entry) => !query.user || entry.user === query.user)
      .slice(-(query.limit ?? 100))
      .reverse();
  }
}
