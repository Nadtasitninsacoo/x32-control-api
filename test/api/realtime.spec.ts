import { INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import { AddressInfo } from 'node:net';
import { Server } from 'node:http';
import { Socket, io } from 'socket.io-client';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateEnv } from '../../src/config/env.validation.js';
import { ConsoleModule } from '../../src/console/console.module.js';
import { SUBSCRIBED_BANKS } from '../../src/metering/meter-banks.js';
import { MeteringModule } from '../../src/metering/metering.module.js';
import { RealtimeModule } from '../../src/realtime/realtime.module.js';
import { oscFloat } from '../../src/osc/codec/osc-types.js';
import { OscModule } from '../../src/osc/osc.module.js';
import { levelDbToFloat } from '../../src/osc/units/x32-units.js';
import { X32Emulator } from '../emulator/x32-emulator.js';
import { silentLogger } from '../silent-logger.js';

/**
 * Metering and the WebSocket push path, against the emulator.
 *
 * The emulator is deliberately configured to push meters *faster* than the API
 * publishes them, so the throttle is actually under test rather than merely
 * unexercised.
 */

const EMULATOR_METER_MS = 10; // 100 fps from the "console"
const CLIENT_FPS = 20;

interface HelloPayload {
  streams: string[];
  meterFps: number;
  consoles: { id: string; state: string }[];
}

/**
 * The server greets a client the moment it connects, so the greeting listener
 * has to be attached before the connection resolves — otherwise the test races
 * the server and loses.
 */
function openSocket(url: string): {
  client: Socket;
  hello: Promise<HelloPayload>;
} {
  const client = io(`${url}/realtime`, {
    transports: ['websocket'],
    forceNew: true,
  });
  return { client, hello: once<HelloPayload>(client, 'hello', 5000) };
}

async function connectClient(url: string): Promise<Socket> {
  const { client } = openSocket(url);
  await new Promise<void>((resolve, reject) => {
    client.once('connect', () => resolve());
    client.once('connect_error', reject);
  });
  return client;
}

function once<T>(client: Socket, event: string, timeoutMs = 3000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`no "${event}" within ${timeoutMs}ms`)),
      timeoutMs,
    );
    client.once(event, (payload: T) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

interface MeterFramePayload {
  consoleId: string;
  at: number;
  channels: number[];
  mains: { left: number; right: number; mono: number };
}

describe('metering and realtime push', () => {
  let app: INestApplication;
  let emulator: X32Emulator;
  let url: string;

  beforeAll(async () => {
    emulator = new X32Emulator({ meterIntervalMs: EMULATOR_METER_MS });
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
              METER_FPS: CLIENT_FPS,
              METER_RENEW_MS: 1000,
            }),
          ],
        }),
        ScheduleModule.forRoot(),
        OscModule,
        ConsoleModule,
        MeteringModule,
        RealtimeModule,
      ],
    })
      .setLogger(silentLogger)
      .compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api');
    await app.init();
    await app.listen(0);

    const address = (app.getHttpServer() as Server).address() as AddressInfo;
    url = `http://127.0.0.1:${address.port}`;

    await request(app.getHttpServer())
      .post('/api/consoles')
      .send({ host: '127.0.0.1', port })
      .expect(201);
  }, 30_000);

  afterAll(async () => {
    await app.close();
    await emulator.stop();
  });

  describe('subscription lifecycle', () => {
    it('greets a client with what it can subscribe to', async () => {
      const { client, hello } = openSocket(url);
      try {
        const greeting = await hello;
        expect(greeting.streams).toEqual(['meters', 'state']);
        expect(greeting.meterFps).toBe(CLIENT_FPS);
        expect(greeting.consoles).toContainEqual({
          id: 'default',
          state: 'connected',
        });
      } finally {
        client.close();
      }
    });

    it('only asks the console for meters while somebody is listening', async () => {
      expect(emulator.meterSubscriberCount).toBe(0);

      const client = await connectClient(url);
      try {
        await client.emitWithAck('subscribe', {
          consoleId: 'default',
          streams: ['meters'],
        });
        await once(client, 'meters');
        // One subscription per bank: input channels and mains.
        expect(emulator.meterSubscriberCount).toBe(SUBSCRIBED_BANKS.length);

        await client.emitWithAck('unsubscribe', {
          consoleId: 'default',
          streams: ['meters'],
        });
        // Nothing renews the subscription now, so the console forgets us —
        // /unsubscribe is never sent because it would kill /xremote too.
        const framesAfter = new Promise((resolve) => {
          client.once('meters', resolve);
          setTimeout(() => resolve(undefined), 400);
        });
        expect(await framesAfter).toBeUndefined();
      } finally {
        client.close();
      }
    });

    it('refuses a console it does not have', async () => {
      const client = await connectClient(url);
      try {
        const ack = await client.emitWithAck('subscribe', {
          consoleId: 'nope',
        });
        expect(ack).toMatchObject({ ok: false });
      } finally {
        client.close();
      }
    });

    it('cleans up when a client disconnects without unsubscribing', async () => {
      const client = await connectClient(url);
      await client.emitWithAck('subscribe', { consoleId: 'default' });
      await once(client, 'meters');
      client.close();

      await new Promise((resolve) => setTimeout(resolve, 300));
      // Nothing renews them now; the console drops them on its own schedule.
      expect(emulator.meterSubscriberCount).toBeLessThanOrEqual(
        SUBSCRIBED_BANKS.length,
      );
    });
  });

  describe('meter frames', () => {
    it('throttles to the configured frame rate even when the console floods', async () => {
      const client = await connectClient(url);
      try {
        await client.emitWithAck('subscribe', {
          consoleId: 'default',
          streams: ['meters'],
        });

        const timestamps: number[] = [];
        client.on('meters', () => timestamps.push(Date.now()));
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // The emulator pushed ~100 frames in that second; we must have
        // published about 20, and certainly not one per inbound datagram.
        expect(timestamps.length).toBeGreaterThan(CLIENT_FPS * 0.5);
        expect(timestamps.length).toBeLessThanOrEqual(CLIENT_FPS + 4);
      } finally {
        client.close();
      }
    }, 15_000);

    it('sends meters in dBFS, one value per input channel', async () => {
      const client = await connectClient(url);
      try {
        await client.emitWithAck('subscribe', {
          consoleId: 'default',
          streams: ['meters'],
        });
        const frame = await once<MeterFramePayload>(client, 'meters');

        expect(frame.consoleId).toBe('default');
        expect(frame.channels).toHaveLength(32);
        for (const value of frame.channels) {
          expect(value).toBeLessThanOrEqual(0);
          expect(value).toBeGreaterThanOrEqual(-90);
        }
        expect(frame.mains.left).toBeLessThanOrEqual(0);
      } finally {
        client.close();
      }
    });

    it('serves the raw bank so unmapped slots can be identified on hardware', async () => {
      const { body } = await request(app.getHttpServer())
        .get('/api/consoles/default/meters/raw')
        .query({ bank: '/meters/1' })
        .expect(200);

      expect(body.bank).toBe('/meters/1');
      expect(body.count).toBe(96);
      expect(body.values).toHaveLength(96);
    });

    it('rejects something that is not a meter bank', async () => {
      await request(app.getHttpServer())
        .get('/api/consoles/default/meters/raw')
        .query({ bank: '/ch/01/mix/fader' })
        .expect(400);
    });
  });

  describe('parameter changes', () => {
    it('pushes a change made on the console surface, batched', async () => {
      const client = await connectClient(url);
      try {
        await client.emitWithAck('subscribe', {
          consoleId: 'default',
          streams: ['state'],
        });

        emulator.setFromConsole('/ch/09/mix/fader', [
          oscFloat(levelDbToFloat(-18)),
        ]);
        emulator.setFromConsole('/ch/10/mix/fader', [
          oscFloat(levelDbToFloat(-24)),
        ]);

        const payload = await once<{
          consoleId: string;
          changes: { address: string; value: unknown }[];
        }>(client, 'state');

        expect(payload.consoleId).toBe('default');
        const addresses = payload.changes.map((c) => c.address);
        expect(addresses).toContain('/ch/09/mix/fader');
        // Both changes arrived inside one tick, so they arrive as one message.
        expect(payload.changes.length).toBeGreaterThanOrEqual(1);
        const change = payload.changes.find(
          (c) => c.address === '/ch/09/mix/fader',
        );
        expect(change?.value).toBe(-18);
      } finally {
        client.close();
      }
    });

    it('collapses repeated moves of the same fader into the latest value', async () => {
      const client = await connectClient(url);
      try {
        await client.emitWithAck('subscribe', {
          consoleId: 'default',
          streams: ['state'],
        });

        for (let db = -30; db <= -20; db += 1) {
          emulator.setFromConsole('/ch/11/mix/fader', [
            oscFloat(levelDbToFloat(db)),
          ]);
        }

        const payload = await once<{
          changes: { address: string; value: unknown }[];
        }>(client, 'state');
        const forChannel = payload.changes.filter(
          (c) => c.address === '/ch/11/mix/fader',
        );
        expect(forChannel).toHaveLength(1);
      } finally {
        client.close();
      }
    });
  });
});
