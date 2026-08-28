import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AppModule } from './../src/app.module.js';
import { SWAGGER_PATH, mountSwagger } from './../src/swagger.js';
import { silentLogger } from './silent-logger.js';

/**
 * Boots the real AppModule with no console configured — the state a fresh
 * `docker compose up` starts in. The API must come up healthy and serve its
 * documentation regardless of whether a console is on the network.
 */
describe('AppModule (e2e)', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .setLogger(silentLogger)
      .compile();

    app = moduleFixture.createNestApplication();
    app.setGlobalPrefix('api');
    mountSwagger(app);
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('/api/health (GET) reports a healthy service with no console attached', async () => {
    const { body } = await request(app.getHttpServer())
      .get('/api/health')
      .expect(200);
    expect(body).toMatchObject({ status: 'ok', consoles: 0, connected: 0 });
  });

  it('serves Swagger UI', async () => {
    await request(app.getHttpServer()).get(`/${SWAGGER_PATH}`).expect(200);
  });
});
