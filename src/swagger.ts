import { INestApplication } from '@nestjs/common';
import { DocumentBuilder, OpenAPIObject, SwaggerModule } from '@nestjs/swagger';

/** Where the interactive documentation lives. */
export const SWAGGER_PATH = 'api/docs';

/**
 * The OpenAPI document is this project's only contract with a frontend: there
 * is no shared package and no shared folder, so `npm run openapi:export` is how
 * types cross the boundary.
 */
export function buildOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('x32-control-api')
    .setDescription(
      [
        'Control API for Behringer X32 / Midas M32 consoles over OSC.',
        '',
        'Every value in this API is in engineering units — dB, Hz, milliseconds, percent —',
        "and every field name carries its unit. The console's raw 0.0–1.0 floats never",
        'cross this boundary.',
        '',
        'Conventions worth knowing before wiring a UI to it:',
        '- `muted` is what it says; the console itself stores the inverse (`/mix/on`).',
        '- A fader at -90 dB is -∞, i.e. fully closed.',
        '- Values outside what the console can do are rejected, never clamped silently.',
        '- With `AUTH_ENABLED=false` no token is needed and every request runs as an',
        '  administrator. With it on, send `Authorization: Bearer <token>` from',
        '  `POST /api/auth/login`; reads need the `observer` role, writes need `engineer`.',
        '- A `423 Locked` means read-only mode is on, not that the request was wrong.',
      ].join('\n'),
    )
    .setVersion('0.1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
      'bearer',
    )
    .addTag(
      'consoles',
      'Find consoles, connect to them, inspect the state mirror',
    )
    .addTag('mixer', 'Channels, buses, matrices, mains and DCAs')
    .addTag(
      'scenes',
      'Scenes, cues and snippets on the console, and .scn files',
    )
    .addTag('venues', 'Rooms, and what was learned about them')
    .addTag('bands', 'Acts and their input lists')
    .addTag('presets', 'Saved mixes, versioned and applied by diff')
    .addTag('room eq', 'Fitting a correction from a measurement')
    .addTag('metering', 'Meter snapshots and raw banks')
    .addTag('auth', 'Logging in and managing accounts')
    .addTag('safety', 'Read-only mode, PANIC, and the audit trail')
    .addTag('health', 'Liveness')
    .build();

  return SwaggerModule.createDocument(app, config);
}

export function mountSwagger(app: INestApplication): OpenAPIObject {
  const document = buildOpenApiDocument(app);
  SwaggerModule.setup(SWAGGER_PATH, app, document, {
    swaggerOptions: { persistAuthorization: true, tryItOutEnabled: true },
    customSiteTitle: 'x32-control-api',
  });
  return document;
}
