import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { Test, TestingModule } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { EnvVars, validateEnv } from '../../src/config/env.validation.js';
import {
  ConsoleManagerService,
  DEFAULT_CONSOLE_ID,
} from '../../src/console/console-manager.service.js';
import { ConsoleModule } from '../../src/console/console.module.js';
import { ConsoleDiscoveryService } from '../../src/console/discovery/console-discovery.service.js';
import { ConnectionState } from '../../src/console/console.types.js';
import { oscFloat, oscString } from '../../src/osc/codec/osc-types.js';
import { levelDbToFloat } from '../../src/osc/units/x32-units.js';
import { silentLogger } from '../silent-logger.js';
import { X32Emulator } from '../emulator/x32-emulator.js';

/**
 * Console lifecycle against the emulator: connect, mirror, notice the link
 * dying, come back.
 */

function waitFor(
  predicate: () => boolean,
  timeoutMs = 5000,
  label = 'condition',
): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = (): void => {
      if (predicate()) return resolve();
      if (Date.now() > deadline)
        return reject(new Error(`${label} not met within ${timeoutMs}ms`));
      setTimeout(poll, 10);
    };
    poll();
  });
}

/** Fast timings so the suite stays quick; the production defaults are asserted separately. */
const FAST_TIMINGS = {
  CONSOLE_AUTO_CONNECT: false,
  CONSOLE_PROBE_INTERVAL_MS: 200,
  CONSOLE_PROBE_TIMEOUT_MS: 200,
  CONSOLE_MAX_MISSED_PROBES: 2,
  CONSOLE_RECONNECT_MIN_MS: 100,
  CONSOLE_RECONNECT_MAX_MS: 400,
  CONSOLE_SYNC_DEPTH: 'surface',
  OSC_MAX_MSG_PER_SEC: 2000,
  OSC_MIN_GAP_MS: 0,
  OSC_REQUEST_TIMEOUT_MS: 500,
  DISCOVERY_TIMEOUT_MS: 300,
};

async function buildModule(
  overrides: Record<string, unknown>,
): Promise<TestingModule> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        validate: validateEnv,
        load: [() => ({ ...FAST_TIMINGS, ...overrides })],
      }),
      ScheduleModule.forRoot(),
      ConsoleModule,
    ],
  })
    .setLogger(silentLogger)
    .compile();
  await moduleRef.init();
  return moduleRef;
}

describe('ConsoleConnection against the emulator', () => {
  let emulator: X32Emulator;
  let moduleRef: TestingModule;
  let manager: ConsoleManagerService;

  beforeEach(async () => {
    emulator = new X32Emulator();
    const port = await emulator.start();
    moduleRef = await buildModule({ X32_HOST: '127.0.0.1', X32_PORT: port });
    manager = moduleRef.get(ConsoleManagerService);
  });

  afterEach(async () => {
    await moduleRef.close();
    await emulator.stop();
  });

  describe('connecting', () => {
    it('identifies the console and reports it as connected', async () => {
      const info = await manager.connect({
        host: '127.0.0.1',
        port: emulator.port,
      });

      expect(info).toMatchObject({
        model: 'X32',
        name: 'X32-EMULATOR',
        firmware: '4.06',
      });
      const [status] = manager.list();
      expect(status.id).toBe(DEFAULT_CONSOLE_ID);
      expect(status.state).toBe('connected');
      expect(status.info?.model).toBe('X32');
    });

    it('subscribes to the parameter feed on connect', async () => {
      await manager.connect({ host: '127.0.0.1', port: emulator.port });
      expect(emulator.xremoteSubscriberCount).toBe(1);
    });

    it('walks the states in order', async () => {
      const seen: ConnectionState[] = [];
      const connecting = manager.connect({
        host: '127.0.0.1',
        port: emulator.port,
      });
      // The connection exists in the registry from the first moment, so a
      // caller can watch it come up.
      await waitFor(
        () => manager.get(DEFAULT_CONSOLE_ID) !== undefined,
        1000,
        'registration',
      );
      manager
        .require(DEFAULT_CONSOLE_ID)
        .onStateChange((state) => seen.push(state));
      await connecting;

      expect(seen).toContain('connected');
      expect(seen.indexOf('connected')).toBe(seen.length - 1);
    });

    it('refuses a duplicate id rather than replacing a live link', async () => {
      await manager.connect({
        host: '127.0.0.1',
        port: emulator.port,
        id: 'foh',
      });
      await expect(
        manager.connect({ host: '127.0.0.1', port: emulator.port, id: 'foh' }),
      ).rejects.toThrow(/already connected/);
    });

    it('reports an unreachable console instead of hanging', async () => {
      // Port 1 has nothing listening on it.
      await expect(
        manager.connect({ host: '127.0.0.1', port: 1, id: 'ghost' }),
      ).rejects.toThrow(/did not answer/);
      expect(manager.require('ghost').state).toBe('disconnected');
    });

    it('keeps two consoles apart', async () => {
      const second = new X32Emulator({ name: 'MONITOR-DESK' });
      const secondPort = await second.start();
      try {
        await manager.connect({
          host: '127.0.0.1',
          port: emulator.port,
          id: 'foh',
        });
        await manager.connect({
          host: '127.0.0.1',
          port: secondPort,
          id: 'mon',
        });

        expect(
          manager
            .list()
            .map((s) => s.id)
            .sort(),
        ).toEqual(['foh', 'mon']);
        expect(manager.require('mon').info?.name).toBe('MONITOR-DESK');
        expect(manager.require('foh').info?.name).toBe('X32-EMULATOR');

        // Each link mirrors its own console.
        second.setFromConsole('/ch/01/mix/fader', [
          oscFloat(levelDbToFloat(-20)),
        ]);
        await waitFor(
          () =>
            manager.require('mon').cache.getValue('/ch/01/mix/fader') === -20,
          2000,
          'second console feed',
        );
        expect(
          manager.require('foh').cache.getValue('/ch/01/mix/fader'),
        ).not.toBe(-20);
      } finally {
        await manager.disconnect('mon');
        await second.stop();
      }
    });
  });

  describe('state mirror', () => {
    beforeEach(async () => {
      emulator.setFromConsole('/ch/01/config/name', [oscString('Kick In')]);
      emulator.setFromConsole('/ch/01/mix/fader', [
        oscFloat(levelDbToFloat(-6)),
      ]);
      await manager.connect({ host: '127.0.0.1', port: emulator.port });
    });

    it('fills the surface of the console from /node queries', async () => {
      const cache = manager.require(DEFAULT_CONSOLE_ID).cache;

      expect(cache.getValue('/ch/01/config/name')).toBe('Kick In');
      expect(cache.getValue('/ch/01/mix/fader')).toBe(-6);
      expect(cache.getValue('/ch/32/mix/on')).toBe(true);
      expect(cache.getValue('/main/st/mix/fader')).toBe(-90);
      expect(cache.getValue('/dca/1/fader')).toBe(-90);
      expect(cache.getValue('/headamp/000/gain')).toBe(0);
      expect(cache.lastSyncAt).toBeDefined();
      // 72 strips plus DCAs and head amps, several values each.
      expect(cache.size).toBeGreaterThan(300);
    });

    it('follows a change made on the console surface', async () => {
      const cache = manager.require(DEFAULT_CONSOLE_ID).cache;
      emulator.setFromConsole('/ch/05/mix/fader', [
        oscFloat(levelDbToFloat(-12)),
      ]);

      await waitFor(
        () => cache.getValue('/ch/05/mix/fader') === -12,
        2000,
        'feed update',
      );
      expect(cache.entry('/ch/05/mix/fader')?.source).toBe('feed');
    });

    it('does not re-poll the console once synced', async () => {
      const connection = manager.require(DEFAULT_CONSOLE_ID);
      await connection.syncSettled;
      const afterSync = emulator.receivedOn('/node').length;

      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(emulator.receivedOn('/node').length).toBe(afterSync);
    });

    it('reads containers individually when a dump does not match the schema', async () => {
      // /fxrtn has no head amp or source field on this emulator; the surface
      // stage still resolves every container it does know.
      const report = await manager.require(DEFAULT_CONSOLE_ID).sync('surface');
      expect(report.applied).toBeGreaterThan(300);
      expect(report.unparsed).toEqual([]);
      expect(report.failed).toBe(0);
    });
  });

  describe('losing and regaining the link (acceptance criterion 4)', () => {
    it('notices the console going away and reconnects when it returns', async () => {
      await manager.connect({ host: '127.0.0.1', port: emulator.port });
      const connection = manager.require(DEFAULT_CONSOLE_ID);
      const port = emulator.port;

      // Pull the cable: the socket stays open, the console stops answering.
      await emulator.stop();

      await waitFor(
        () => connection.state === 'reconnecting',
        3000,
        'link loss detection',
      );
      expect(connection.status().missedProbes).toBeGreaterThanOrEqual(2);

      // Plug it back in on the same address.
      const restarted = new X32Emulator({ port, name: 'X32-EMULATOR' });
      await restarted.start();
      try {
        const replugged = Date.now();
        await waitFor(
          () => connection.state === 'connected',
          10_000,
          'reconnect',
        );
        expect(Date.now() - replugged).toBeLessThan(10_000);

        // The mirror is refreshed, because changes made while we were away
        // were never pushed to us.
        restarted.setFromConsole('/ch/02/mix/fader', [
          oscFloat(levelDbToFloat(-3)),
        ]);
        await waitFor(
          () => connection.cache.getValue('/ch/02/mix/fader') === -3,
          3000,
          'feed after reconnect',
        );
        expect(restarted.xremoteSubscriberCount).toBe(1);
      } finally {
        await restarted.stop();
      }
    }, 30_000);

    it('keeps trying while the console stays away', async () => {
      await manager.connect({ host: '127.0.0.1', port: emulator.port });
      const connection = manager.require(DEFAULT_CONSOLE_ID);
      await emulator.stop();

      await waitFor(
        () => connection.state === 'reconnecting',
        3000,
        'link loss detection',
      );
      await new Promise((resolve) => setTimeout(resolve, 800));

      expect(connection.state).toBe('reconnecting');
      expect(connection.status().reconnectAttempts).toBeGreaterThan(1);
    }, 15_000);
  });

  describe('discovery', () => {
    it('finds a console that answers the /info probe', async () => {
      const discovery = moduleRef.get(ConsoleDiscoveryService);
      // Loopback rather than 255.255.255.255: broadcast is blocked in most CI
      // sandboxes, and the probe/collect logic is identical either way.
      const found = await discovery.discover({
        address: '127.0.0.1',
        port: emulator.port,
      });

      expect(found).toHaveLength(1);
      expect(found[0]).toMatchObject({
        host: '127.0.0.1',
        port: emulator.port,
        model: 'X32',
        name: 'X32-EMULATOR',
      });
      expect(found[0].rttMs).toBeGreaterThanOrEqual(0);
    });

    it('returns nothing when no console answers', async () => {
      const discovery = moduleRef.get(ConsoleDiscoveryService);
      expect(
        await discovery.discover({ address: '127.0.0.1', port: 1 }),
      ).toEqual([]);
    });
  });
});

describe('auto-connect at boot', () => {
  it('connects the configured console without being asked', async () => {
    const emulator = new X32Emulator();
    const port = await emulator.start();
    const moduleRef = await buildModule({
      X32_HOST: '127.0.0.1',
      X32_PORT: port,
      CONSOLE_AUTO_CONNECT: true,
    });
    try {
      const manager = moduleRef.get(ConsoleManagerService);
      await waitFor(
        () => manager.get(DEFAULT_CONSOLE_ID)?.state === 'connected',
        5000,
        'auto-connect',
      );
      expect(manager.require(DEFAULT_CONSOLE_ID).info?.model).toBe('X32');
    } finally {
      await moduleRef.close();
      await emulator.stop();
    }
  });

  it('starts anyway when the console is switched off', async () => {
    const moduleRef = await buildModule({
      X32_HOST: '127.0.0.1',
      X32_PORT: 1,
      CONSOLE_AUTO_CONNECT: true,
    });
    try {
      const manager = moduleRef.get(ConsoleManagerService);
      expect(manager.get(DEFAULT_CONSOLE_ID)?.state).toBe('disconnected');
    } finally {
      await moduleRef.close();
    }
  });
});

describe('supervision defaults', () => {
  it('detects a dead link and reconnects inside the 10s requirement', () => {
    const defaults = validateEnv({}) as EnvVars;
    const worstCaseDetection =
      defaults.CONSOLE_PROBE_INTERVAL_MS * defaults.CONSOLE_MAX_MISSED_PROBES +
      defaults.CONSOLE_PROBE_TIMEOUT_MS;
    const worstCaseRecovery =
      worstCaseDetection + defaults.CONSOLE_RECONNECT_MAX_MS;

    expect(worstCaseRecovery).toBeLessThanOrEqual(10_000);
    // And the renewal period still has to stay inside the console's own 10s
    // subscription lifetime.
    expect(defaults.XREMOTE_INTERVAL_MS).toBeLessThan(10_000);
  });
});
