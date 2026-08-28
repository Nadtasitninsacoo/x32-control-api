import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateEnv } from '../../src/config/env.validation.js';
import { message } from '../../src/osc/codec/osc-codec.js';
import {
  argAsNumber,
  argAsString,
  oscFloat,
  oscInt,
  oscString,
} from '../../src/osc/codec/osc-types.js';
import { OscClient } from '../../src/osc/client/osc-client.js';
import { OscClientFactory } from '../../src/osc/client/osc-client.factory.js';
import { XRemoteHeartbeatService } from '../../src/osc/heartbeat/xremote-heartbeat.service.js';
import { OscModule } from '../../src/osc/osc.module.js';
import { OscPriority } from '../../src/osc/rate-limit/osc-rate-limiter.js';
import {
  levelDbToFloat,
  levelFloatToDb,
  meterToDbfs,
  mutedToOnInt,
} from '../../src/osc/units/x32-units.js';
import { silentLogger } from '../silent-logger.js';
import { X32Emulator } from '../emulator/x32-emulator.js';

/**
 * End-to-end over a real UDP socket, against the emulator. Nothing here needs
 * a console, a database or a network beyond loopback — it runs in CI.
 */

const FADER_CH01 = '/ch/01/mix/fader';

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline)
        return reject(new Error('condition not met in time'));
      setTimeout(poll, 5);
    };
    poll();
  });
}

describe('OSC link against the X32 emulator', () => {
  let emulator: X32Emulator;
  let client: OscClient;

  beforeEach(async () => {
    emulator = new X32Emulator({ subscriptionTtlMs: 10_000 });
    const port = await emulator.start();
    client = new OscClient({
      id: 'emulator',
      remote: { host: '127.0.0.1', port },
      maxPerSecond: 50,
      minGapMs: 2,
      requestTimeoutMs: 1000,
    });
    await client.open();
  });

  afterEach(async () => {
    await client.close();
    await emulator.stop();
  });

  describe('identity', () => {
    it('reads /info', async () => {
      const reply = await client.get('/info');
      expect(reply.address).toBe('/info');
      expect(reply.args.map((a) => argAsString(a))).toEqual([
        'V2.07',
        'X32-EMULATOR',
        'X32',
        '4.06',
      ]);
    });

    it('reads /xinfo', async () => {
      const reply = await client.get('/xinfo');
      expect(argAsString(reply.args[2])).toBe('X32');
    });

    it('times out on an address the console does not answer', async () => {
      await expect(
        client.get('/no/such/parameter', { timeoutMs: 150 }),
      ).rejects.toThrow(/no reply/);
    });
  });

  describe('parameters in engineering units', () => {
    it('sets channel 1 to -6 dB and reads back -6 dB (acceptance criterion 3)', async () => {
      await client.set(FADER_CH01, [oscFloat(levelDbToFloat(-6))]);
      await waitFor(() => emulator.get(FADER_CH01) !== undefined);

      const reply = await client.get(FADER_CH01);
      const db = levelFloatToDb(argAsNumber(reply.args[0]) ?? Number.NaN);
      expect(db).toBeGreaterThan(-6.1);
      expect(db).toBeLessThan(-5.9);
    });

    it('holds every level across the whole fader range within 0.1 dB', async () => {
      for (const db of [10, 0, -6, -12, -30, -60, -90]) {
        await client.set(FADER_CH01, [oscFloat(levelDbToFloat(db))]);
        const reply = await client.get(FADER_CH01);
        const readBack = levelFloatToDb(
          argAsNumber(reply.args[0]) ?? Number.NaN,
        );
        expect(Math.abs(readBack - db)).toBeLessThanOrEqual(0.1);
      }
    });

    it('mutes a channel by clearing /mix/on', async () => {
      await client.set('/ch/01/mix/on', [oscInt(mutedToOnInt(true))]);
      const reply = await client.get('/ch/01/mix/on');
      expect(argAsNumber(reply.args[0])).toBe(0);
    });

    it('writes and reads a channel name', async () => {
      await client.set('/ch/01/config/name', [oscString('Kick In')]);
      const reply = await client.get('/ch/01/config/name');
      expect(argAsString(reply.args[0])).toBe('Kick In');
    });
  });

  describe('/node queries', () => {
    it('answers on the bare address "node" and dumps display units', async () => {
      await client.set(FADER_CH01, [oscFloat(levelDbToFloat(-6))]);
      const reply = await client.nodeQuery('ch/01/mix/fader');

      expect(reply.address).toBe('node');
      expect(argAsString(reply.args[0])).toBe('/ch/01/mix/fader -6.0');
    });

    it('dumps a container in schema order, in display units', async () => {
      const reply = await client.nodeQuery('ch/01/config');
      // name, icon, colour, source — the order the schema declares.
      expect(argAsString(reply.args[0])).toBe('/ch/01/config "" 1 WH 0');
    });
  });

  describe('/xremote feed', () => {
    it('subscribes and receives console-side changes', async () => {
      const seen: number[] = [];
      client.onMessage((msg) => {
        if (msg.address === FADER_CH01)
          seen.push(argAsNumber(msg.args[0]) ?? Number.NaN);
      });

      await client.sendXRemote();
      await waitFor(() => emulator.xremoteSubscriberCount === 1);

      emulator.setFromConsole(FADER_CH01, [oscFloat(levelDbToFloat(-12))]);
      await waitFor(() => seen.length === 1);

      expect(levelFloatToDb(seen[0])).toBeCloseTo(-12, 1);
    });

    it('stops receiving once the subscription lapses, and resumes on renewal', async () => {
      const emu = new X32Emulator({ subscriptionTtlMs: 60 });
      const port = await emu.start();
      const link = new OscClient({
        id: 'ttl',
        remote: { host: '127.0.0.1', port },
        maxPerSecond: 200,
        minGapMs: 2,
        requestTimeoutMs: 500,
      });
      await link.open();
      try {
        await link.sendXRemote();
        await waitFor(() => emu.xremoteSubscriberCount === 1);
        await new Promise((resolve) => setTimeout(resolve, 80));
        expect(emu.xremoteSubscriberCount).toBe(0);

        await link.sendXRemote();
        await waitFor(() => emu.xremoteSubscriberCount === 1);
      } finally {
        await link.close();
        await emu.stop();
      }
    });
  });

  describe('metering', () => {
    it('decodes a meter blob into dBFS values', async () => {
      const reply = await client.get('/meters/1');
      const blob = reply.args[0];
      expect(blob.type).toBe('b');
      if (blob.type !== 'b') return;

      const count = blob.value.readInt32LE(0);
      expect(count).toBe(96);
      expect(blob.value.length).toBe(4 + count * 4);

      const dbfs = Array.from({ length: count }, (_, i) =>
        meterToDbfs(blob.value.readFloatLE(4 + i * 4)),
      );
      expect(dbfs).toHaveLength(96);
      for (const value of dbfs) {
        expect(value).toBeLessThanOrEqual(0);
        expect(value).toBeGreaterThanOrEqual(-90);
      }
    });

    it('pushes blobs while subscribed', async () => {
      let blobs = 0;
      client.onMessage((msg) => {
        if (msg.address === '/meters/1') blobs += 1;
      });
      await client.send(
        message('/subscribe', oscString('/meters/1')),
        OscPriority.Housekeeping,
      );
      await waitFor(() => blobs >= 3, 3000);
      expect(blobs).toBeGreaterThanOrEqual(3);
    });
  });

  describe('pacing', () => {
    it('delivers a 500-command burst without loss (acceptance criterion 5)', async () => {
      const fast = new OscClient({
        id: 'burst',
        // Pacing correctness at the configured 50/s is covered by the
        // rate-limiter unit test with fake timers; here we only need enough
        // traffic to prove nothing is dropped end to end.
        remote: { host: '127.0.0.1', port: emulator.port },
        maxPerSecond: 500,
        minGapMs: 2,
        requestTimeoutMs: 1000,
      });
      await fast.open();
      try {
        const sends = Array.from({ length: 500 }, (_, i) =>
          fast.set(FADER_CH01, [oscFloat(levelDbToFloat(-90 + (i % 100)))]),
        );
        await Promise.all(sends);
        await waitFor(
          () => emulator.receivedOn(FADER_CH01).length === 500,
          10_000,
        );

        expect(emulator.receivedOn(FADER_CH01)).toHaveLength(500);
        expect(fast.stats.queue.rejected).toBe(0);
        expect(fast.stats.queue.sent).toBe(500);
      } finally {
        await fast.close();
      }
    }, 20_000);
  });

  describe('DRY_RUN', () => {
    it('suppresses writes but still allows reads', async () => {
      const safe = new OscClient({
        id: 'dry',
        remote: { host: '127.0.0.1', port: emulator.port },
        maxPerSecond: 200,
        minGapMs: 2,
        requestTimeoutMs: 1000,
        dryRun: true,
      });
      await safe.open();
      try {
        const before = emulator.get(FADER_CH01);
        await safe.set(FADER_CH01, [oscFloat(levelDbToFloat(0))]);
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(emulator.get(FADER_CH01)).toEqual(before);

        const reply = await safe.get('/info');
        expect(argAsString(reply.args[2])).toBe('X32');
        expect(safe.stats.transport.suppressed).toBe(1);
      } finally {
        await safe.close();
      }
    });
  });
});

describe('XRemoteHeartbeatService (wired through Nest)', () => {
  let moduleRef: TestingModule;
  let emulator: X32Emulator;
  let client: OscClient;

  beforeEach(async () => {
    emulator = new X32Emulator({ subscriptionTtlMs: 10_000 });
    const port = await emulator.start();

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          validate: validateEnv,
          load: [() => ({ X32_HOST: '127.0.0.1', X32_PORT: port })],
        }),
        ScheduleModule.forRoot(),
        OscModule,
      ],
    })
      .setLogger(silentLogger)
      .compile();
    await moduleRef.init();

    client = moduleRef.get(OscClientFactory).create({
      id: 'heartbeat-test',
      remote: { host: '127.0.0.1', port },
    });
    await client.open();
  });

  afterEach(async () => {
    await client.close();
    await moduleRef.close();
    await emulator.stop();
  });

  it('builds clients from configuration', () => {
    expect(moduleRef.get(OscClientFactory).configuredEndpoint).toEqual({
      host: '127.0.0.1',
      port: emulator.port,
    });
  });

  it('subscribes on registration and renews on every tick', async () => {
    const heartbeat = moduleRef.get(XRemoteHeartbeatService);
    expect(heartbeat.intervalMs).toBe(8000);
    expect(heartbeat.intervalMs).toBeLessThan(10_000);

    heartbeat.register(client);
    await waitFor(() => emulator.receivedOn('/xremote').length === 1);

    await heartbeat.tick();
    await waitFor(() => emulator.receivedOn('/xremote').length === 2);

    heartbeat.unregister(client.id);
    await heartbeat.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(emulator.receivedOn('/xremote')).toHaveLength(2);
  });
});
