import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplyModule } from '../apply/apply.module.js';
import { ConsoleModule } from '../console/console.module.js';
import { EnvVars } from '../config/env.validation.js';
import { PresetModule } from '../preset/preset.module.js';
import { AUDIT_STORE, MemoryAuditStore } from './audit.store.js';
import type { AuditStore } from './audit.store.js';
import { SafetyController } from './safety.controller.js';
import { SafetyService } from './safety.service.js';

/**
 * Read-only mode, PANIC, and the audit trail. Global, because the read-only
 * guard and the audit interceptor apply to every other module.
 */
@Global()
@Module({
  imports: [ConsoleModule, PresetModule, ApplyModule],
  controllers: [SafetyController],
  providers: [
    SafetyService,
    {
      provide: AUDIT_STORE,
      inject: [ConfigService],
      useFactory: async (
        config: ConfigService<EnvVars, true>,
      ): Promise<AuditStore> => {
        const url = config.get('DATABASE_URL', { infer: true });
        const logger = new Logger('AuditStorage');

        if (!url) {
          logger.warn(
            'DATABASE_URL is not set — the audit trail is kept in memory and will be lost ' +
              'when this process stops.',
          );
          return new MemoryAuditStore();
        }

        const { PrismaAuditStore } = await import('./prisma-audit.store.js');
        const store = new PrismaAuditStore(url);
        try {
          await store.connect();
          return store;
        } catch (error) {
          logger.error(
            `could not reach the database for the audit trail: ${
              error instanceof Error ? error.message : String(error)
            }. Falling back to memory.`,
          );
          return new MemoryAuditStore();
        }
      },
    },
  ],
  exports: [SafetyService],
})
export class SafetyModule {}
