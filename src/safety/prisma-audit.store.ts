import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import type {
  AuditEntryRecord,
  AuditQuery,
  AuditStore,
} from './audit.store.js';

/** PostgreSQL-backed audit trail, used when `DATABASE_URL` is set. */
@Injectable()
export class PrismaAuditStore implements AuditStore, OnModuleDestroy {
  readonly kind = 'postgres' as const;
  private readonly prisma: PrismaClient;

  constructor(connectionString: string) {
    this.prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }

  async connect(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
  }

  async record(entry: Omit<AuditEntryRecord, 'id' | 'at'>): Promise<void> {
    await this.prisma.auditEntry.create({
      data: {
        user: entry.user,
        action: entry.action,
        consoleId: entry.consoleId,
        detail: (entry.detail ?? undefined) as
          Prisma.InputJsonValue | undefined,
      },
    });
  }

  async list(query: AuditQuery = {}): Promise<AuditEntryRecord[]> {
    const entries = await this.prisma.auditEntry.findMany({
      where: { consoleId: query.consoleId, user: query.user },
      orderBy: { at: 'desc' },
      take: query.limit ?? 100,
    });
    return entries.map((entry) => ({
      ...entry,
      detail: (entry.detail as Record<string, unknown> | null) ?? null,
    }));
  }
}
