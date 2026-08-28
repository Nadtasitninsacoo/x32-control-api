import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ScheduleModule } from '@nestjs/schedule';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ApplyModule } from '../../src/apply/apply.module.js';
import { AuthGuard } from '../../src/auth/auth.guard.js';
import { AuthModule } from '../../src/auth/auth.module.js';
import { validateEnv } from '../../src/config/env.validation.js';
import { ConsoleModule } from '../../src/console/console.module.js';
import { HealthModule } from '../../src/health/health.module.js';
import { MixerModule } from '../../src/mixer/mixer.module.js';
import { OscModule } from '../../src/osc/osc.module.js';
import { PresetModule } from '../../src/preset/preset.module.js';
import { AuditInterceptor } from '../../src/safety/audit.interceptor.js';
import { ReadOnlyGuard } from '../../src/safety/read-only.guard.js';
import { SafetyModule } from '../../src/safety/safety.module.js';
import { levelFloatToDb } from '../../src/osc/units/x32-units.js';
import { X32Emulator } from '../emulator/x32-emulator.js';
import { silentLogger } from '../silent-logger.js';

/**
 * Authentication and the safety layer, with the guards wired the way the real
 * application wires them.
 */
describe('auth and safety', () => {
  let app: INestApplication;
  let emulator: X32Emulator;
  let http: () => request.Agent;

  let adminToken: string;
  let engineerToken: string;
  let observerToken: string;

  const bearer = (token: string): string => `Bearer ${token}`;
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
              CONSOLE_AUTO_CONNECT: false,
              CONSOLE_SYNC_DEPTH: 'surface',
              OSC_MAX_MSG_PER_SEC: 2000,
              OSC_MIN_GAP_MS: 0,
              OSC_REQUEST_TIMEOUT_MS: 500,
              AUTH_ENABLED: true,
              JWT_SECRET: 'test-secret-that-is-long-enough-to-be-a-secret',
              AUTH_BOOTSTRAP_USERNAME: 'boss',
              AUTH_BOOTSTRAP_PASSWORD: 'a very long bootstrap password',
            }),
          ],
        }),
        ScheduleModule.forRoot(),
        OscModule,
        ConsoleModule,
        ApplyModule,
        MixerModule,
        PresetModule,
        AuthModule,
        SafetyModule,
        HealthModule,
      ],
      providers: [
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: ReadOnlyGuard },
        { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
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

    const login = await http()
      .post('/api/auth/login')
      .send({ username: 'boss', password: 'a very long bootstrap password' })
      .expect(200);
    adminToken = login.body.accessToken;

    await http()
      .post('/api/auth/users')
      .set('authorization', bearer(adminToken))
      .send({
        username: 'sam',
        password: 'sam at front of house',
        role: 'engineer',
      })
      .expect(201);
    await http()
      .post('/api/auth/users')
      .set('authorization', bearer(adminToken))
      .send({
        username: 'guest',
        password: 'guest of the promoter',
        role: 'observer',
      })
      .expect(201);

    engineerToken = (
      await http()
        .post('/api/auth/login')
        .send({ username: 'sam', password: 'sam at front of house' })
        .expect(200)
    ).body.accessToken;
    observerToken = (
      await http()
        .post('/api/auth/login')
        .send({ username: 'guest', password: 'guest of the promoter' })
        .expect(200)
    ).body.accessToken;

    await http()
      .post('/api/consoles')
      .set('authorization', bearer(engineerToken))
      .send({ host: '127.0.0.1', port })
      .expect(201);
  }, 60_000);

  afterAll(async () => {
    await app.close();
    await emulator.stop();
  });

  describe('logging in', () => {
    it('creates the first administrator from the bootstrap variables', async () => {
      const { body } = await http()
        .get('/api/auth/me')
        .set('authorization', bearer(adminToken))
        .expect(200);
      expect(body).toMatchObject({ username: 'boss', role: 'admin' });
    });

    it('refuses a wrong password and an unknown user alike', async () => {
      await http()
        .post('/api/auth/login')
        .send({ username: 'boss', password: 'wrong' })
        .expect(401);
      await http()
        .post('/api/auth/login')
        .send({ username: 'nobody', password: 'wrong' })
        .expect(401);
    });

    it('needs a token for anything that is not public', async () => {
      await http().get('/api/consoles').expect(401);
      await http()
        .get('/api/consoles')
        .set('authorization', 'Bearer nonsense')
        .expect(401);
      // Health is how a load balancer checks the service; it stays open.
      await http().get('/api/health').expect(200);
    });
  });

  describe('roles', () => {
    it('lets an observer read', async () => {
      await http()
        .get('/api/consoles/default/strips/ch/1')
        .set('authorization', bearer(observerToken))
        .expect(200);
      await http()
        .get('/api/safety')
        .set('authorization', bearer(observerToken))
        .expect(200);
    });

    it('does not let an observer change anything', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .set('authorization', bearer(observerToken))
        .send({ mix: { faderDb: 0 } })
        .expect(403);
    });

    it('lets an observer run the calculations that send nothing', async () => {
      const preset = await http()
        .post('/api/presets')
        .set('authorization', bearer(engineerToken))
        .send({
          name: 'For preview',
          consoleId: 'default',
          capture: { strips: ['ch/01'] },
        })
        .expect(201);

      await http()
        .post(`/api/presets/${preset.body.id}/preview`)
        .set('authorization', bearer(observerToken))
        .send({ consoleId: 'default' })
        .expect(200);
    });

    it('lets an engineer mix', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .set('authorization', bearer(engineerToken))
        .send({ mix: { faderDb: -6 } })
        .expect(200);
    });

    it('keeps user management to administrators', async () => {
      await http()
        .get('/api/auth/users')
        .set('authorization', bearer(engineerToken))
        .expect(403);
      await http()
        .get('/api/auth/users')
        .set('authorization', bearer(adminToken))
        .expect(200);
    });

    it('stops a disabled account immediately, without waiting for the token to expire', async () => {
      const users = await http()
        .get('/api/auth/users')
        .set('authorization', bearer(adminToken))
        .expect(200);
      const guest = users.body.find(
        (user: { username: string }) => user.username === 'guest',
      );

      await http()
        .patch(`/api/auth/users/${guest.id}`)
        .set('authorization', bearer(adminToken))
        .send({ disabled: true })
        .expect(200);

      // The token is still valid on paper; the account is not.
      await http()
        .get('/api/consoles')
        .set('authorization', bearer(observerToken))
        .expect(401);

      await http()
        .patch(`/api/auth/users/${guest.id}`)
        .set('authorization', bearer(adminToken))
        .send({ disabled: false })
        .expect(200);
      await http()
        .get('/api/consoles')
        .set('authorization', bearer(observerToken))
        .expect(200);
    });
  });

  describe('read-only mode', () => {
    afterAll(async () => {
      await http()
        .post('/api/safety/read-only')
        .set('authorization', bearer(adminToken))
        .send({ enabled: false })
        .expect(200);
    });

    it('refuses writes with 423 Locked while it is on', async () => {
      await http()
        .post('/api/safety/read-only')
        .set('authorization', bearer(adminToken))
        .send({ enabled: true, reason: 'guest engineer driving' })
        .expect(200);

      const response = await http()
        .patch('/api/consoles/default/strips/ch/1')
        .set('authorization', bearer(engineerToken))
        .send({ mix: { faderDb: 0 } })
        .expect(423);
      expect(response.body.message).toContain('read-only');

      // And the console was not touched.
      expect(faderOnEmulator('/ch/01/mix/fader')).toBeCloseTo(-6, 1);
    });

    it('still allows reads and the calculations that send nothing', async () => {
      const status = await http()
        .get('/api/safety')
        .set('authorization', bearer(observerToken))
        .expect(200);
      expect(status.body).toMatchObject({
        readOnly: true,
        readOnlyReason: 'guest engineer driving',
      });

      await http()
        .get('/api/consoles/default/strips/ch/1')
        .set('authorization', bearer(observerToken))
        .expect(200);
    });

    it('only an administrator can lift it', async () => {
      await http()
        .post('/api/safety/read-only')
        .set('authorization', bearer(engineerToken))
        .send({ enabled: false })
        .expect(403);
    });
  });

  describe('panic', () => {
    it('captures a safe state and comes back to it', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .set('authorization', bearer(engineerToken))
        .send({ mix: { faderDb: -6 } })
        .expect(200);

      await http()
        .post('/api/safety/safe-state')
        .set('authorization', bearer(engineerToken))
        .send({ consoleId: 'default' })
        .expect(200);

      // Something goes wrong.
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .set('authorization', bearer(engineerToken))
        .send({ mix: { faderDb: 10 } })
        .expect(200);
      expect(faderOnEmulator('/ch/01/mix/fader')).toBeCloseTo(10, 1);

      const { body } = await http()
        .post('/api/safety/panic')
        .set('authorization', bearer(engineerToken))
        .send({ consoleId: 'default' })
        .expect(200);

      expect(body.mode).toBe('safe-state');
      // Restored, and not ramped: this is not a musical transition.
      expect(body.apply.rampedFaders).toBe(0);
      expect(faderOnEmulator('/ch/01/mix/fader')).toBeCloseTo(-6, 1);
    }, 30_000);

    it('works while read-only is on, because that is the point of it', async () => {
      await http()
        .post('/api/safety/read-only')
        .set('authorization', bearer(adminToken))
        .send({ enabled: true })
        .expect(200);

      try {
        await http()
          .post('/api/safety/panic')
          .set('authorization', bearer(engineerToken))
          .send({ consoleId: 'default' })
          .expect(200);
      } finally {
        await http()
          .post('/api/safety/read-only')
          .set('authorization', bearer(adminToken))
          .send({ enabled: false })
          .expect(200);
      }
    }, 30_000);

    it('mutes everything when there is nothing captured to go back to', async () => {
      const { body } = await http()
        .post('/api/safety/panic')
        .set('authorization', bearer(engineerToken))
        .send({ consoleId: 'default', mode: 'mute-all' })
        .expect(200);

      expect(body.apply.changed).toBeGreaterThan(0);
      const strip = await http()
        .get('/api/consoles/default/strips/ch/2')
        .set('authorization', bearer(engineerToken))
        .expect(200);
      expect(strip.body.mix.muted).toBe(true);
    }, 30_000);

    it('says so when asked to restore a safe state that was never captured', async () => {
      await http()
        .post('/api/safety/panic')
        .set('authorization', bearer(engineerToken))
        .send({ consoleId: 'nope' })
        .expect(404);
    });
  });

  describe('the audit trail', () => {
    it('records who changed what', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/8')
        .set('authorization', bearer(engineerToken))
        .send({ mix: { faderDb: -11 } })
        .expect(200);

      const { body } = await http()
        .get('/api/safety/audit')
        .set('authorization', bearer(engineerToken))
        .query({ limit: 50 })
        .expect(200);

      const entry = body.find(
        (row: { action: string }) =>
          row.action === 'PATCH /api/consoles/default/strips/ch/8',
      );
      expect(entry).toBeDefined();
      expect(entry.user).toBe('sam');
      expect(entry.consoleId).toBe('default');
      // The request itself is what answers "who changed what"; the outcome
      // identifies the thing that came back.
      expect(entry.detail.mix).toContain('-11');
      expect(entry.detail.outcome).toMatchObject({ id: 'ch/08' });
    });

    it('never writes a password into the log', async () => {
      await http()
        .post('/api/auth/login')
        .send({ username: 'sam', password: 'sam at front of house' })
        .expect(200);

      const { body } = await http()
        .get('/api/safety/audit')
        .set('authorization', bearer(adminToken))
        .query({ limit: 50 })
        .expect(200);

      const login = body.find(
        (row: { action: string }) => row.action === 'POST /api/auth/login',
      );
      expect(login).toBeDefined();
      expect(login.detail.password).toBe('[redacted]');
      expect(JSON.stringify(body)).not.toContain('sam at front of house');
    });

    it('does not fill itself with reads', async () => {
      await http()
        .get('/api/consoles/default/strips/ch/1')
        .set('authorization', bearer(observerToken))
        .expect(200);

      const { body } = await http()
        .get('/api/safety/audit')
        .set('authorization', bearer(adminToken))
        .query({ limit: 100 })
        .expect(200);

      expect(
        body.every((row: { action: string }) => !row.action.startsWith('GET')),
      ).toBe(true);
    });

    it('records a refused request too, because that is also worth knowing', async () => {
      await http()
        .patch('/api/consoles/default/strips/ch/1')
        .set('authorization', bearer(observerToken))
        .send({ mix: { faderDb: 0 } })
        .expect(403);

      const { body } = await http()
        .get('/api/safety/audit')
        .set('authorization', bearer(adminToken))
        .query({ limit: 20 })
        .expect(200);

      expect(
        body.some(
          (row: { detail?: { outcome?: string } }) =>
            row.detail?.outcome === 'failed',
        ),
      ).toBe(true);
    });

    it('is only readable by an engineer or above', async () => {
      await http()
        .get('/api/safety/audit')
        .set('authorization', bearer(observerToken))
        .expect(403);
    });
  });
});
