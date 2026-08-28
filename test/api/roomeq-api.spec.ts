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
import { RoomEqModule } from '../../src/roomeq/roomeq.module.js';
import { logGrid, peakingResponseDb } from '../../src/roomeq/dsp/peq-fitter.js';
import { X32Emulator } from '../emulator/x32-emulator.js';
import { silentLogger } from '../silent-logger.js';

/**
 * Room EQ end to end: a measured room in as a file, filters out, and onto a bus.
 */

/** A REW-shaped export of a room with a fat 160 Hz resonance. */
function rewExport(shape: (hz: number) => number): string {
  const lines = [
    '* Measurement data measured by REW V5.20',
    '* Dated: 28-Aug-2026 18:04:11',
    '* Freq(Hz) SPL(dB) Phase(degrees)',
  ];
  for (const hz of logGrid(20, 20000, 400)) {
    lines.push(`${hz.toFixed(3)}  ${(82 + shape(hz)).toFixed(3)}  0.0`);
  }
  return lines.join('\n');
}

const RESONANT_ROOM = rewExport(
  (hz) => peakingResponseDb(hz, 160, 9, 3) + peakingResponseDb(hz, 2500, -5, 4),
);

describe('room EQ', () => {
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
              CONSOLE_SYNC_DEPTH: 'full',
              OSC_MAX_MSG_PER_SEC: 2000,
              OSC_MIN_GAP_MS: 0,
              OSC_REQUEST_TIMEOUT_MS: 500,
            }),
          ],
        }),
        ScheduleModule.forRoot(),
        OscModule,
        ConsoleModule,
        ApplyModule,
        MixerModule,
        RoomEqModule,
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

  describe('analysis', () => {
    it('reads a REW export and fits a correction', async () => {
      const { body } = await http()
        .post('/api/roomeq/analyze')
        .send({ measurement: RESONANT_ROOM, bands: 6 })
        .expect(200);

      expect(body.measurementPoints).toBe(400);
      expect(body.notes[0]).toContain('REW');
      expect(body.bands.length).toBeGreaterThan(0);

      // The resonance gets cut, not boosted.
      const worst = body.bands[0];
      expect(worst.frequencyHz).toBeGreaterThan(120);
      expect(worst.frequencyHz).toBeLessThan(220);
      expect(worst.gainDb).toBeLessThan(0);

      expect(body.deviationAfterDb).toBeLessThan(body.deviationBeforeDb);
    });

    it('returns curves a frontend can plot directly', async () => {
      const { body } = await http()
        .post('/api/roomeq/analyze')
        .send({ measurement: RESONANT_ROOM })
        .expect(200);

      const { frequencies, before, after, target } = body.curves;
      expect(frequencies.length).toBeGreaterThan(100);
      expect(before).toHaveLength(frequencies.length);
      expect(after).toHaveLength(frequencies.length);
      expect(target).toHaveLength(frequencies.length);
      expect(frequencies[0]).toBeLessThan(frequencies.at(-1));
    });

    it('touches no console', async () => {
      // Counting parameter writes rather than every datagram: the link is live,
      // so /xremote renewals keep arriving regardless of what this endpoint does.
      const writes = (): number =>
        emulator.received.filter(
          (m) => m.address.includes('/eq/') && m.args.length > 0,
        ).length;

      const before = writes();
      await http()
        .post('/api/roomeq/analyze')
        .send({ measurement: RESONANT_ROOM })
        .expect(200);
      expect(writes()).toBe(before);
    });

    it('honours the boost ceiling and the correction range', async () => {
      const suckout = rewExport((hz) => peakingResponseDb(hz, 300, -18, 1.5));
      const { body } = await http()
        .post('/api/roomeq/analyze')
        .send({ measurement: suckout, maxBoostDb: 4, minHz: 40, maxHz: 8000 })
        .expect(200);

      for (const band of body.bands) {
        expect(band.gainDb).toBeLessThanOrEqual(4);
        expect(band.frequencyHz).toBeGreaterThanOrEqual(40);
        expect(band.frequencyHz).toBeLessThanOrEqual(8000);
      }
      expect(body.warnings.join(' ')).toContain('boost ceiling');
    });

    it('says so when there is nothing worth correcting', async () => {
      const { body } = await http()
        .post('/api/roomeq/analyze')
        .send({ measurement: rewExport(() => 0) })
        .expect(200);

      expect(body.bands).toHaveLength(0);
      expect(body.warnings.join(' ')).toContain('nothing to correct');
    });

    it('warns when the measurement does not cover the correction range', async () => {
      const narrow = [
        '* partial sweep',
        ...logGrid(100, 4000, 200).map(
          (hz) => `${hz.toFixed(2)} ${(80).toFixed(2)}`,
        ),
      ].join('\n');

      const { body } = await http()
        .post('/api/roomeq/analyze')
        .send({ measurement: narrow })
        .expect(200);

      expect(body.warnings.join(' ')).toMatch(/starts at 100 Hz/);
      expect(body.warnings.join(' ')).toMatch(/stops at 4000 Hz/);
    });

    it('refuses a file that is not a measurement', async () => {
      await http()
        .post('/api/roomeq/analyze')
        .send({ measurement: 'this is my shopping list' })
        .expect(400);
    });

    it('refuses settings outside what the console can do', async () => {
      await http()
        .post('/api/roomeq/analyze')
        .send({ measurement: RESONANT_ROOM, maxBoostDb: 40 })
        .expect(400);
      await http()
        .post('/api/roomeq/analyze')
        .send({ measurement: RESONANT_ROOM, bands: 12 })
        .expect(400);
    });
  });

  describe('applying to a strip', () => {
    it('writes the correction to a bus EQ and switches it on', async () => {
      const { body } = await http()
        .post('/api/consoles/default/roomeq/apply')
        .send({ strip: 'bus/01', measurement: RESONANT_ROOM })
        .expect(200);

      expect(body.strip).toBe('bus/01');
      expect(body.bands.length).toBeGreaterThan(0);
      expect(body.apply.changed).toBeGreaterThan(0);

      const strip = await http()
        .get('/api/consoles/default/strips/bus/1')
        .expect(200);
      expect(strip.body.eq.on).toBe(true);

      const first = body.bands[0];
      const written = strip.body.eq.bands[first.band - 1];
      expect(written.type).toBe('PEQ');
      expect(written.frequencyHz).toBeCloseTo(first.frequencyHz, -1);
      expect(written.gainDb).toBeCloseTo(first.gainDb, 0);
      expect(written.q).toBeCloseTo(first.q, 0);
    }, 20_000);

    it('flattens the bands the correction does not use', async () => {
      await http()
        .patch('/api/consoles/default/strips/bus/2')
        .send({
          eq: { on: true, bands: [{ band: 6, gainDb: 12, frequencyHz: 5000 }] },
        })
        .expect(200);

      const { body } = await http()
        .post('/api/consoles/default/roomeq/apply')
        .send({ strip: 'bus/02', measurement: RESONANT_ROOM })
        .expect(200);

      const used = new Set(
        body.bands.map((band: { band: number }) => band.band),
      );
      const strip = await http()
        .get('/api/consoles/default/strips/bus/2')
        .expect(200);

      for (const band of strip.body.eq.bands) {
        // An older correction must not stay half-applied underneath a new one.
        if (!used.has(band.band)) expect(band.gainDb).toBe(0);
      }
    }, 20_000);

    it('accepts bands the operator edited by hand', async () => {
      const { body } = await http()
        .post('/api/consoles/default/roomeq/apply')
        .send({
          strip: 'bus/03',
          bandValues: [{ band: 1, frequencyHz: 250, gainDb: -3, q: 2 }],
        })
        .expect(200);

      expect(body.analysis).toBeUndefined();
      const strip = await http()
        .get('/api/consoles/default/strips/bus/3')
        .expect(200);
      expect(strip.body.eq.bands[0].frequencyHz).toBeCloseTo(250, -1);
      expect(strip.body.eq.bands[0].gainDb).toBeCloseTo(-3, 0);
    }, 20_000);

    it('refuses a strip with no EQ, and a request with nothing to apply', async () => {
      await http()
        .post('/api/consoles/default/roomeq/apply')
        .send({ strip: 'dca/1', measurement: RESONANT_ROOM })
        .expect(400);

      await http()
        .post('/api/consoles/default/roomeq/apply')
        .send({ strip: 'bus/01' })
        .expect(400);

      await http()
        .post('/api/consoles/default/roomeq/apply')
        .send({ strip: 'nonsense', measurement: RESONANT_ROOM })
        .expect(400);
    });

    it('refuses a band the strip does not have', async () => {
      await http()
        .post('/api/consoles/default/roomeq/apply')
        .send({
          strip: 'ch/01',
          bandValues: [{ band: 6, frequencyHz: 1000, gainDb: -3, q: 2 }],
        })
        .expect(400);
    });
  });
});
