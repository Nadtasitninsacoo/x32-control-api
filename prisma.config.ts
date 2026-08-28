import { defineConfig, env } from 'prisma/config';

/**
 * Prisma 7 keeps the connection URL out of the schema file, so migrations read
 * it from here. The application itself never reads this file: it builds its
 * client from `DATABASE_URL` through the pg adapter, and falls back to the
 * in-memory preset store when no database is configured.
 */
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env('DATABASE_URL'),
  },
});
