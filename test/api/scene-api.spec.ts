import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ApplyModule } from '../../src/apply/apply.module.js';
import { validateEnv } from '../../src/config/env.validation.js';
import { ConsoleModule } from '../../src/console/console.module.js';
import { MixerModule } from '../../src/mixer/mixer.module.js';
import { OscModule } from '../../src/osc/osc.module.js';
import { SceneModule } from '../../src/scene/scene.module.js';
import { levelFloatToDb } from '../../src/osc/units/x32-units.js';
import { X32Emulator } from '../emulator/x32-emulator.js';
import { silentLogger } from '../silent-logger.js';

/** Scenes on the console, and .scn files in and out. */
describe('scenes and .scn files', () => {
  let app: INestApplication;
  let emulator: X32Emulator;
  let http: () => request.Agent;

  const faderDbOnEmulator = (address: string): number => {
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
        SceneModule,
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

  describe('scenes on the console', () => {
    it('saves a scene, but only with the confirmation token', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ mix: { faderDb: -6 }, config: { name: 'Kick In' } })
        .expect(200);

      await http()
        .post('/api/consoles/default/show/scene/save')
        .send({ index: 0, name: 'Rock Night' })
        .expect(400); // confirm is required by the DTO

      await http()
        .post('/api/consoles/default/show/scene/save')
        .send({ index: 0, name: 'Rock Night', confirm: 'yes please' })
        .expect(403);

      const { body } = await http()
        .post('/api/consoles/default/show/scene/save')
        .send({
          index: 0,
          name: 'Rock Night',
          note: 'FOH base',
          confirm: 'OVERWRITE',
        })
        .expect(201);

      // Honest about what it cannot promise: the save command is not verified
      // against hardware.
      expect(body).toMatchObject({
        index: 0,
        name: 'Rock Night',
        verified: false,
      });
    });

    it('lists the occupied slots', async () => {
      const { body } = await http()
        .get('/api/consoles/default/show/scene')
        .expect(200);
      expect(body).toContainEqual({
        index: 0,
        name: 'Rock Night',
        note: 'FOH base',
      });
      // Unused slots are not listed as empty rows.
      expect(body.length).toBeLessThan(5);
    });

    it('recalls a scene and brings the mirror back with it', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .send({ mix: { faderDb: -30 } })
        .expect(200);
      expect(faderDbOnEmulator('/ch/01/mix/fader')).toBeCloseTo(-30, 1);

      await http()
        .post('/api/consoles/default/show/scene/recall')
        .send({ index: 0 })
        .expect(204);

      expect(faderDbOnEmulator('/ch/01/mix/fader')).toBeCloseTo(-6, 1);
      const { body } = await http()
        .get('/api/consoles/default/strips/ch/1')
        .expect(200);
      expect(body.mix.faderDb).toBe(-6);
    });

    it('rejects a slot the console does not have', async () => {
      await http()
        .post('/api/consoles/default/show/scene/recall')
        .send({ index: 500 })
        .expect(400);
    });

    it('reports the current cue', async () => {
      const { body } = await http()
        .get('/api/consoles/default/show/current-cue')
        .expect(200);
      expect(typeof body.index === 'number' || body.index === undefined).toBe(
        true,
      );
    });
  });

  describe('.scn export', () => {
    it('writes a scene file of the current mixing state', async () => {
      const response = await http()
        .get('/api/consoles/default/show/export.scn')
        .query({ name: 'Export Test', note: 'from the API' })
        .expect(200);

      expect(response.headers['content-type']).toContain('text/plain');
      const lines = response.text.split('\n');
      expect(lines[0]).toBe('#2.7# "Export Test" "from the API" %000000000 1');
      expect(response.text).toContain('/ch/01/config "Kick In" 1 WH 0');
      expect(response.text).toContain('/ch/01/mix ON -6.0');
      expect(response.text).toContain('/main/st/mix');
      expect(response.text).toContain('/dca/1');
    });
  });

  describe('.scn import', () => {
    const sceneFile = [
      '#2.7# "Imported" "from a file" %000000000 1',
      '/ch/02/config "Snare Top" 1 RD 2',
      '/ch/02/mix ON 0.0 ON +0 OFF -oo',
      '/fx/1/type DLY',
      '/ch/03/mix ON -6.0 ON +0 OFF -oo EXTRA',
    ].join('\n');

    beforeEach(async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/2')
        .send({ mix: { faderDb: -90 } })
        .expect(200);
    });

    it('reports what a file contains without touching the console', async () => {
      const before = faderDbOnEmulator('/ch/02/mix/fader');

      const { body } = await http()
        .post('/api/consoles/default/show/import')
        .send({ content: sceneFile })
        .expect(200);

      expect(body).toMatchObject({
        name: 'Imported',
        note: 'from a file',
        version: '2.7',
        applied: false,
        unknownLines: 1,
      });
      expect(body.parsedValues).toBeGreaterThan(4);
      // The malformed line is named, not silently dropped and not decoded.
      expect(body.rejectedLines).toHaveLength(1);
      expect(body.rejectedLines[0]).toContain('EXTRA');

      expect(faderDbOnEmulator('/ch/02/mix/fader')).toBe(before);
    });

    it('will not touch the console without the confirmation token', async () => {
      await http()
        .post('/api/consoles/default/show/import')
        .send({ content: sceneFile, apply: true })
        .expect(403);
    });

    it('applies the file, ramping levels instead of jumping them', async () => {
      const messagesBefore = emulator.receivedOn('/ch/02/mix/fader').length;

      const { body } = await http()
        .post('/api/consoles/default/show/import')
        .send({
          content: sceneFile,
          apply: true,
          confirm: 'OVERWRITE',
          rampMs: 300,
        })
        .expect(200);

      expect(body.applied).toBe(true);
      expect(body.apply.changed).toBeGreaterThan(0);
      expect(body.apply.rampedFaders).toBeGreaterThanOrEqual(1);

      // -90 dB to 0 dB arrived as a walk, not a jump.
      const faderMessages =
        emulator.receivedOn('/ch/02/mix/fader').length - messagesBefore;
      expect(faderMessages).toBeGreaterThan(1);
      expect(faderDbOnEmulator('/ch/02/mix/fader')).toBeCloseTo(0, 1);

      const { body: strip } = await http()
        .get('/api/consoles/default/strips/ch/2')
        .expect(200);
      expect(strip.config.name).toBe('Snare Top');
      expect(strip.mix.faderDb).toBe(0);
    }, 20_000);

    it('sends nothing when the file matches the console already', async () => {
      await http()
        .post('/api/consoles/default/show/import')
        .send({ content: sceneFile, apply: true, confirm: 'OVERWRITE' })
        .expect(200);

      const { body } = await http()
        .post('/api/consoles/default/show/import')
        .send({ content: sceneFile, apply: true, confirm: 'OVERWRITE' })
        .expect(200);

      expect(body.apply.changed).toBe(0);
      expect(body.apply.messages).toBe(0);
      expect(body.apply.unchanged).toBeGreaterThan(0);
    }, 20_000);

    it('refuses something that is not a scene file', async () => {
      await http()
        .post('/api/consoles/default/show/import')
        .send({ content: '{"not":"a scene"}' })
        .expect(400);
    });
  });
});
