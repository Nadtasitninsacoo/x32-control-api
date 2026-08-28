import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateEnv } from '../../src/config/env.validation.js';
import { ConsoleModule } from '../../src/console/console.module.js';
import { HealthModule } from '../../src/health/health.module.js';
import { MixerModule } from '../../src/mixer/mixer.module.js';
import { OscModule } from '../../src/osc/osc.module.js';
import { SWAGGER_PATH, mountSwagger } from '../../src/swagger.js';
import {
  levelDbToFloat,
  levelFloatToDb,
} from '../../src/osc/units/x32-units.js';
import { X32Emulator } from '../emulator/x32-emulator.js';
import { silentLogger } from '../silent-logger.js';

/**
 * The REST surface, end to end: HTTP in, OSC out, against the emulator.
 * Covers acceptance criteria 1 (Swagger UI is reachable) and 2 (no hardware).
 */

describe('REST API', () => {
  let app: INestApplication;
  let emulator: X32Emulator;
  let http: () => request.Agent;

  beforeAll(async () => {
    emulator = new X32Emulator();
    const port = await emulator.start();

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: validateEnv,
          load: [
            () => ({
              X32_HOST: '127.0.0.1',
              X32_PORT: port,
              CONSOLE_AUTO_CONNECT: false,
              CONSOLE_SYNC_DEPTH: 'surface',
              OSC_MAX_MSG_PER_SEC: 2000,
              OSC_MIN_GAP_MS: 0,
              OSC_REQUEST_TIMEOUT_MS: 500,
            }),
          ],
        }),
        ScheduleModule.forRoot(),
        OscModule,
        ConsoleModule,
        MixerModule,
        HealthModule,
      ],
    })
      .setLogger(silentLogger)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );
    mountSwagger(app);
    await app.init();

    http = () => request(app.getHttpServer());

    await http()
      .post('/api/consoles')
      .send({ host: '127.0.0.1', port })
      .expect(201);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await emulator.stop();
  });

  describe('service surface', () => {
    it('reports health', async () => {
      const { body } = await http().get('/api/health').expect(200);
      expect(body).toMatchObject({
        status: 'ok',
        consoles: 1,
        connected: 1,
        dryRun: false,
      });
    });

    it('serves the Swagger UI (acceptance criterion 1)', async () => {
      const response = await http().get(`/${SWAGGER_PATH}`).expect(200);
      expect(response.text).toContain('swagger');
    });

    it('serves the OpenAPI document', async () => {
      const { body } = await http().get(`/${SWAGGER_PATH}-json`).expect(200);
      expect(body.info.title).toBe('x32-control-api');
      expect(Object.keys(body.paths)).toContain(
        '/api/consoles/{consoleId}/strips',
      );
    });
  });

  describe('consoles', () => {
    it('lists the connected console', async () => {
      const { body } = await http().get('/api/consoles').expect(200);
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({
        id: 'default',
        state: 'connected',
        host: '127.0.0.1',
        dryRun: false,
      });
      expect(body[0].info.model).toBe('X32');
      expect(body[0].cachedAddresses).toBeGreaterThan(300);
    });

    it('404s for a console it does not have', async () => {
      await http().get('/api/consoles/nope').expect(404);
    });

    it('refuses a malformed connect body', async () => {
      await http()
        .post('/api/consoles')
        .send({ host: 'not a host!' })
        .expect(400);
      await http()
        .post('/api/consoles')
        .send({ host: '127.0.0.1', extra: 1 })
        .expect(400);
    });

    it('exposes the state mirror for troubleshooting', async () => {
      const { body } = await http()
        .get('/api/consoles/default/state')
        .query({ prefix: '/ch/01/mix' })
        .expect(200);
      expect(body['/ch/01/mix/fader']).toBeDefined();
    });
  });

  describe('strips', () => {
    it('lists every strip on the console', async () => {
      const { body } = await http()
        .get('/api/consoles/default/strips')
        .expect(200);
      // 32 ch + 8 auxin + 8 fxrtn + 16 bus + 6 mtx + 2 main + 8 dca
      expect(body).toHaveLength(80);
      expect(body[0]).toMatchObject({ id: 'ch/01', kind: 'ch', index: '01' });
      expect(body.at(-1)).toMatchObject({ id: 'dca/8', kind: 'dca' });
    });

    it('reads a channel in engineering units', async () => {
      const { body } = await http()
        .get('/api/consoles/default/strips/ch/1')
        .expect(200);

      expect(body).toMatchObject({
        id: 'ch/01',
        kind: 'ch',
        oscRoot: '/ch/01',
      });
      expect(body.mix).toMatchObject({ muted: false, faderDb: -90 });
      expect(body.eq.bands).toHaveLength(4);
      expect(body.sends).toHaveLength(16);
      expect(body.preamp.gainDb).toBe(0);
      expect(body.gate).toBeDefined();
      expect(body.dynamics).toBeDefined();
    });

    it('accepts an unpadded index and the main aliases', async () => {
      await http().get('/api/consoles/default/strips/ch/01').expect(200);
      const { body } = await http()
        .get('/api/consoles/default/strips/main/lr')
        .expect(200);
      expect(body.id).toBe('main/st');
      expect(body.eq.bands).toHaveLength(6);
    });

    it('omits sections a strip does not have', async () => {
      const { body } = await http()
        .get('/api/consoles/default/strips/dca/1')
        .expect(200);
      expect(body.mix).toMatchObject({ muted: false, faderDb: -90 });
      expect(body.eq).toBeUndefined();
      expect(body.gate).toBeUndefined();
      expect(body.sends).toBeUndefined();
    });

    it('rejects a strip the console does not have', async () => {
      await http().get('/api/consoles/default/strips/ch/33').expect(400);
      await http().get('/api/consoles/default/strips/wibble/1').expect(400);
      await http().get('/api/consoles/default/strips/main/x').expect(400);
    });
  });

  describe('writing to the console', () => {
    it('sets a fader in dB and the console holds that value', async () => {
      const { body } = await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ mix: { faderDb: -6 } })
        .expect(200);

      expect(body.mix.faderDb).toBe(-6);

      const raw = emulator.get('/ch/01/mix/fader');
      expect(raw?.[0].type).toBe('f');
      expect(
        levelFloatToDb(raw?.[0].type === 'f' ? raw[0].value : Number.NaN),
      ).toBeCloseTo(-6, 1);
    });

    it('mutes without the caller ever seeing the inverted /mix/on', async () => {
      const { body } = await http()
        .patch('/api/consoles/default/strips/ch/2')
        .send({ mix: { muted: true } })
        .expect(200);

      expect(body.mix.muted).toBe(true);
      // The console stores the opposite polarity.
      const raw = emulator.get('/ch/02/mix/on');
      expect(raw?.[0].type === 'i' ? raw[0].value : undefined).toBe(0);
    });

    it('writes name, colour, EQ and a send in one request', async () => {
      const { body } = await http()
        .patch('/api/consoles/default/strips/ch/3')
        .send({
          config: { name: 'Kick In', color: 'GN' },
          eq: {
            on: true,
            bands: [{ band: 2, frequencyHz: 1000, gainDb: -4.5, q: 2 }],
          },
          sends: [{ to: 5, on: true, levelDb: -12 }],
          preamp: { gainDb: 24, phantom: true, lowCutOn: true, lowCutHz: 80 },
        })
        .expect(200);

      expect(body.config).toMatchObject({ name: 'Kick In', color: 'GN' });
      expect(body.eq.bands[1]).toMatchObject({ band: 2, gainDb: -4.5 });
      expect(body.eq.bands[1].frequencyHz).toBeCloseTo(1000, 0);
      expect(body.eq.bands[1].q).toBeCloseTo(2, 1);
      expect(body.sends[4]).toMatchObject({ to: 5, on: true, levelDb: -12 });
      expect(body.preamp).toMatchObject({
        gainDb: 24,
        phantom: true,
        lowCutOn: true,
      });
      expect(body.preamp.lowCutHz).toBeCloseTo(80, 0);
    });

    it('snaps a compressor ratio to what the console offers', async () => {
      const { body } = await http()
        .patch('/api/consoles/default/strips/ch/4')
        .send({ dynamics: { on: true, ratio: 3.4 } })
        .expect(200);
      expect(body.dynamics.ratio).toBe(3);
    });

    it('rejects values the console cannot represent instead of clamping them', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ mix: { faderDb: 20 } })
        .expect(400);
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ eq: { bands: [{ band: 1, gainDb: 30 }] } })
        .expect(400);
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ preamp: { gainDb: 99 } })
        .expect(400);
    });

    it('rejects a section the strip does not have', async () => {
      await http()
        .patch('/api/consoles/default/strips/dca/1')
        .send({ eq: { on: true } })
        .expect(400);
      await http()
        .patch('/api/consoles/default/strips/bus/1')
        .send({ gate: { on: true } })
        .expect(400);
      await http()
        .patch('/api/consoles/default/strips/mtx/1')
        .send({ sends: [{ to: 1, levelDb: -10 }] })
        .expect(400);
    });

    it('rejects an unknown field rather than ignoring it', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ mix: { faderDB: -6 } })
        .expect(400);
    });

    it('rejects an empty update', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({})
        .expect(400);
    });

    it('leaves everything else alone', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/5')
        .send({ config: { name: 'Snare' } })
        .expect(200);
      await http()
        .patch('/api/consoles/default/strips/ch/5')
        .send({ mix: { faderDb: -3 } })
        .expect(200);

      const { body } = await http()
        .get('/api/consoles/default/strips/ch/5')
        .expect(200);
      expect(body.config.name).toBe('Snare');
      expect(body.mix.faderDb).toBe(-3);
    });
  });

  describe('DRY_RUN', () => {
    it('is reported in the console status so a UI can warn the operator', async () => {
      const { body } = await http().get('/api/consoles/default').expect(200);
      expect(body).toHaveProperty('dryRun', false);
    });
  });

  describe('the console pushing back', () => {
    it('shows a change made on the physical surface', async () => {
      emulator.setFromConsole('/ch/06/mix/fader', [
        { type: 'f', value: levelDbToFloat(-24) },
      ]);
      await new Promise((resolve) => setTimeout(resolve, 150));

      const { body } = await http()
        .get('/api/consoles/default/strips/ch/6')
        .expect(200);
      expect(body.mix.faderDb).toBe(-24);
    });
  });
});
