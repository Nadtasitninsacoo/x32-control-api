/**
 * Writes `openapi.json` at the repository root.
 *
 * This file is the only channel through which a frontend learns this API's
 * types — there is no shared package and no shared folder — so the export must
 * not depend on a console being reachable: auto-connect is forced off and the
 * app is never listened on.
 *
 * It lives under `src/` rather than `scripts/` on purpose: it needs the same
 * TypeScript build as the app, because Nest's dependency injection relies on
 * `emitDecoratorMetadata`, which the fast TS runners strip.
 */
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module.js';
import { buildOpenApiDocument } from '../swagger.js';

process.env.CONSOLE_AUTO_CONNECT = 'false';

const app = await NestFactory.create(AppModule, { logger: false });
app.setGlobalPrefix('api');
await app.init();

const document = buildOpenApiDocument(app);
const target = resolve(process.cwd(), 'openapi.json');
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, 'utf8');

const paths = Object.keys(document.paths ?? {}).length;
const schemas = Object.keys(document.components?.schemas ?? {}).length;
process.stdout.write(
  `openapi.json written: ${paths} paths, ${schemas} schemas\n`,
);

await app.close();
