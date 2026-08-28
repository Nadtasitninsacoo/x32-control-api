import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApplyModule } from '../apply/apply.module.js';
import { ConsoleModule } from '../console/console.module.js';
import { EnvVars } from '../config/env.validation.js';
import { MemoryPresetStore } from './memory-preset.store.js';
import {
  BandController,
  PresetController,
  VenueController,
} from './preset.controller.js';
import { PresetService } from './preset.service.js';
import { PRESET_STORE, PresetStore } from './preset.store.js';

/**
 * Venue presets, and the storage decision behind them.
 *
 * With `DATABASE_URL` set, presets live in PostgreSQL and outlive the process.
 * Without it, they live in memory: everything works, nothing survives a
 * restart, and the log says so at boot. That is what keeps the promise that a
 * fresh clone runs with `npm install && npm run start:dev` and no
 * infrastructure at all — and what keeps the test suite free of a database.
 */
@Module({
  imports: [ConsoleModule, ApplyModule],
  controllers: [VenueController, BandController, PresetController],
  providers: [
    PresetService,
    {
      provide: PRESET_STORE,
      inject: [ConfigService],
      useFactory: async (
        config: ConfigService<EnvVars, true>,
      ): Promise<PresetStore> => {
        const logger = new Logger('PresetStorage');
        const url = config.get('DATABASE_URL', { infer: true });

        if (!url) {
          logger.warn(
            'DATABASE_URL is not set — venue presets are kept in memory and will be lost ' +
              'when this process stops. Set it (docker compose does) to keep them.',
          );
          return new MemoryPresetStore();
        }

        // Imported lazily so the generated Prisma client is only required when
        // a database is actually configured.
        const { PrismaPresetStore } = await import('./prisma-preset.store.js');
        const store = new PrismaPresetStore(url);
        try {
          await store.connect();
          return store;
        } catch (error) {
          logger.error(
            `could not reach the database at DATABASE_URL: ${
              error instanceof Error ? error.message : String(error)
            }. Falling back to in-memory presets so the console can still be mixed.`,
          );
          return new MemoryPresetStore();
        }
      },
    },
  ],
  exports: [PresetService],
})
export class PresetModule {}
