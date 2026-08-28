import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { randomBytes } from 'node:crypto';
import { EnvVars } from '../config/env.validation.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';
import { MemoryUserStore, USER_STORE } from './user.store.js';
import type { UserStore } from './user.store.js';

/**
 * Authentication, and the storage decision behind it — the same shape the
 * preset module uses: PostgreSQL when DATABASE_URL is set, memory otherwise.
 *
 * Global, because the guard that protects every other module lives here.
 */
@Global()
@Module({
  imports: [
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService<EnvVars, true>) => {
        const configured = config.get('JWT_SECRET', { infer: true });
        const enabled = config.get('AUTH_ENABLED', { infer: true });

        if (enabled && !configured) {
          // Refusing to start beats starting with a signing key an attacker
          // could guess.
          throw new Error(
            'AUTH_ENABLED is true but JWT_SECRET is empty. Set a long random JWT_SECRET.',
          );
        }

        return {
          // With auth off, nothing verifies these tokens anyway; a random key
          // per process is safer than a constant somebody might rely on.
          secret: configured || randomBytes(32).toString('base64url'),
          signOptions: { algorithm: 'HS256' },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    AuthService,
    {
      provide: USER_STORE,
      inject: [ConfigService],
      useFactory: async (
        config: ConfigService<EnvVars, true>,
      ): Promise<UserStore> => {
        const url = config.get('DATABASE_URL', { infer: true });
        if (!url) return new MemoryUserStore();

        const logger = new Logger('UserStorage');
        const { PrismaUserStore } = await import('./prisma-user.store.js');
        const store = new PrismaUserStore(url);
        try {
          await store.connect();
          return store;
        } catch (error) {
          logger.error(
            `could not reach the database for user storage: ${
              error instanceof Error ? error.message : String(error)
            }. Falling back to in-memory accounts.`,
          );
          return new MemoryUserStore();
        }
      },
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
