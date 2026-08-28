import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplyModule } from '../../src/apply/apply.module.js';
import { validateEnv } from '../../src/config/env.validation.js';
import { ConsoleModule } from '../../src/console/console.module.js';
import { MixerModule } from '../../src/mixer/mixer.module.js';
import { OscModule } from '../../src/osc/osc.module.js';
import { PresetModule } from '../../src/preset/preset.module.js';
import { levelFloatToDb } from '../../src/osc/units/x32-units.js';
import { X32Emulator } from '../emulator/x32-emulator.js';
import { silentLogger } from '../silent-logger.js';

/**
 * Venue presets end to end: capture a mix, change the console, put it back.
 *
 * No DATABASE_URL is set here, so this runs on the in-memory store — which is
 * the same code path a fresh clone gets, and the reason the suite needs no
 * database.
 */
describe('venue presets', () => {
  let app: INestApplication;
  let emulator: X32Emulator;
  let http: () => request.Agent;

  const faderOnEmulator = (address: string): number => {
    const raw = emulator.get(address);
    return raw?.[0].type === 'f' ? levelFloatToDb(raw[0].value) : Number.NaN;
  };

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
              DATABASE_URL: '',
              CONSOLE_AUTO_CONNECT: false,
              CONSOLE_SYNC_DEPTH: 'surface',
              OSC_MAX_MSG_PER_SEC: 2000,
              OSC_MIN_GAP_MS: 0,
              OSC_REQUEST_TIMEOUT_MS: 500,
              RAMP_DEFAULT_MS: 300,
            }),
          ],
        }),
        ScheduleModule.forRoot(),
        OscModule,
        ConsoleModule,
        ApplyModule,
        MixerModule,
        PresetModule,
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

  describe('venues and bands', () => {
    it('keeps what the engineer learned about a room', async () => {
      const { body } = await http()
        .post('/api/venues')
        .send({
          name: 'The Old Hall',
          roomSize: '800 cap, concrete rear wall',
          notes: 'Rings at 160 Hz. Keep the subs off the wall.',
        })
        .expect(201);

      expect(body).toMatchObject({ name: 'The Old Hall' });
      expect(body.id).toBeTruthy();

      const list = await http().get('/api/venues').expect(200);
      expect(list.body).toHaveLength(1);
    });

    it('refuses a duplicate venue name', async () => {
      await http()
        .post('/api/venues')
        .send({ name: 'The Old Hall' })
        .expect(409);
    });

    it('stores a band with its input list', async () => {
      const { body } = await http()
        .post('/api/bands')
        .send({
          name: 'The Loud Ones',
          notes: 'In-ears, no wedges',
          inputList: [
            {
              input: 1,
              name: 'Kick In',
              color: 'GN',
              gainDb: 24,
              phantom: false,
            },
            {
              input: 2,
              name: 'Snare Top',
              color: 'RD',
              gainDb: 30,
              phantom: false,
            },
          ],
        })
        .expect(201);

      expect(body.inputList).toHaveLength(2);
    });

    it('writes the input list onto the console', async () => {
      const bands = await http().get('/api/bands').expect(200);
      const bandId = bands.body[0].id;

      const { body } = await http()
        .post(`/api/bands/${bandId}/apply-input-list`)
        .send({ consoleId: 'default' })
        .expect(200);

      expect(body.changed).toBeGreaterThan(0);

      const strip = await http()
        .get('/api/consoles/default/strips/ch/1')
        .expect(200);
      expect(strip.body.config.name).toBe('Kick In');
      expect(strip.body.config.color).toBe('GN');
      expect(strip.body.preamp.gainDb).toBe(24);
    });

    it('rejects an input list entry the console could not honour', async () => {
      await http()
        .post('/api/bands')
        .send({ name: 'Bad List', inputList: [{ input: 99, name: 'Nope' }] })
        .expect(400);
    });
  });

  describe('capturing and applying a preset', () => {
    let presetId: string;

    it('captures the console as it stands', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ mix: { faderDb: -6 } })
        .expect(200);
      await http()
        .patch('/api/consoles/default/strips/ch/2')
        .send({ mix: { faderDb: -12 } })
        .expect(200);

      const venues = await http().get('/api/venues').expect(200);
      const { body } = await http()
        .post('/api/presets')
        .send({
          name: 'Rock Night — FOH',
          description: 'Base mix before the support act',
          venueId: venues.body[0].id,
          consoleId: 'default',
          capture: { strips: ['ch/01', 'ch/02'], sections: ['mix', 'config'] },
          note: 'after soundcheck',
        })
        .expect(201);

      presetId = body.id;
      expect(body.version).toBe(1);

      const versions = await http()
        .get(`/api/presets/${presetId}/versions`)
        .expect(200);
      expect(versions.body[0].values['/ch/01/mix/fader']).toBe(-6);
      expect(versions.body[0].values['/ch/02/mix/fader']).toBe(-12);
      // The capture was scoped, so nothing outside it was recorded.
      expect(versions.body[0].values['/ch/03/mix/fader']).toBeUndefined();
      expect(versions.body[0].values['/ch/01/eq/1/f']).toBeUndefined();
    });

    it('says what applying it would do, without sending anything', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ mix: { faderDb: -40 } })
        .expect(200);

      const before = emulator.receivedOn('/ch/01/mix/fader').length;
      const { body } = await http()
        .post(`/api/presets/${presetId}/preview`)
        .send({ consoleId: 'default' })
        .expect(200);

      expect(body.changes).toContainEqual(
        expect.objectContaining({
          address: '/ch/01/mix/fader',
          from: -40,
          to: -6,
          ramped: true,
        }),
      );
      expect(body.unchanged).toBeGreaterThan(0);
      expect(emulator.receivedOn('/ch/01/mix/fader')).toHaveLength(before);
    });

    it('applies only what differs, ramping the faders', async () => {
      const before = emulator.receivedOn('/ch/01/mix/fader').length;

      const { body } = await http()
        .post(`/api/presets/${presetId}/apply`)
        .send({ consoleId: 'default', rampMs: 300 })
        .expect(200);

      expect(body.changed).toBeGreaterThan(0);
      expect(body.rampedFaders).toBeGreaterThanOrEqual(1);
      expect(faderOnEmulator('/ch/01/mix/fader')).toBeCloseTo(-6, 1);

      // A ramp, not a jump.
      expect(
        emulator.receivedOn('/ch/01/mix/fader').length - before,
      ).toBeGreaterThan(1);
    }, 20_000);

    it('sends nothing when the console already matches', async () => {
      const { body } = await http()
        .post(`/api/presets/${presetId}/apply`)
        .send({ consoleId: 'default' })
        .expect(200);

      expect(body.changed).toBe(0);
      expect(body.messages).toBe(0);
    }, 20_000);

    it('applies immediately when asked, for when speed beats smoothness', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ mix: { faderDb: -60 } })
        .expect(200);
      const before = emulator.receivedOn('/ch/01/mix/fader').length;

      const { body } = await http()
        .post(`/api/presets/${presetId}/apply`)
        .send({ consoleId: 'default', immediate: true })
        .expect(200);

      expect(body.rampedFaders).toBe(0);
      expect(emulator.receivedOn('/ch/01/mix/fader').length - before).toBe(1);
      expect(faderOnEmulator('/ch/01/mix/fader')).toBeCloseTo(-6, 1);
    });

    it('keeps a version history and can go back', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ mix: { faderDb: 0 } })
        .expect(200);

      const captured = await http()
        .post(`/api/presets/${presetId}/versions`)
        .send({
          consoleId: 'default',
          capture: { strips: ['ch/01', 'ch/02'], sections: ['mix', 'config'] },
          note: 'louder for the headline set',
        })
        .expect(201);

      expect(captured.body.version).toBe(2);
      expect(captured.body.values['/ch/01/mix/fader']).toBe(0);

      const rolled = await http()
        .post(`/api/presets/${presetId}/rollback`)
        .send({ version: 1 })
        .expect(200);
      expect(rolled.body.version).toBe(1);

      // Rolling back does not delete the newer version.
      const versions = await http()
        .get(`/api/presets/${presetId}/versions`)
        .expect(200);
      expect(versions.body.map((v: { version: number }) => v.version)).toEqual([
        2, 1,
      ]);

      // And applying now uses version 1 again.
      await http()
        .post(`/api/presets/${presetId}/apply`)
        .send({ consoleId: 'default', immediate: true })
        .expect(200);
      expect(faderOnEmulator('/ch/01/mix/fader')).toBeCloseTo(-6, 1);
    }, 20_000);

    it('can apply a specific older version without changing the head', async () => {
      const { body } = await http()
        .post(`/api/presets/${presetId}/apply`)
        .send({ consoleId: 'default', version: 2, immediate: true })
        .expect(200);

      expect(body.changed).toBeGreaterThan(0);
      expect(faderOnEmulator('/ch/01/mix/fader')).toBeCloseTo(0, 1);

      const preset = await http().get(`/api/presets/${presetId}`).expect(200);
      expect(preset.body.version).toBe(1);
    }, 20_000);

    it('404s for a preset or version that does not exist', async () => {
      await http().get('/api/presets/nope').expect(404);
      await http().get(`/api/presets/${presetId}/versions/99`).expect(404);
      await http()
        .post(`/api/presets/${presetId}/apply`)
        .send({ consoleId: 'default', version: 99 })
        .expect(404);
    });

    it('filters presets by venue', async () => {
      const venues = await http().get('/api/venues').expect(200);
      const { body } = await http()
        .get('/api/presets')
        .query({ venueId: venues.body[0].id })
        .expect(200);
      expect(body).toHaveLength(1);
      expect(body[0].id).toBe(presetId);
    });
  });
});
