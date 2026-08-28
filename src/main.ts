import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { EnvVars } from './config/env.validation.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      transformOptions: { enableImplicitConversion: false },
    }),
  );
  // Closes sockets and cancels the /xremote heartbeat on SIGTERM.
  app.enableShutdownHooks();

  const config = app.get<ConfigService<EnvVars, true>>(ConfigService);
  const port = config.get('PORT', { infer: true });

  await app.listen(port, '0.0.0.0');

  const logger = new Logger('Bootstrap');
  logger.log(`x32-control-api listening on :${port}`);
  if (config.get('DRY_RUN', { infer: true })) {
    logger.warn(
      'DRY_RUN is enabled — state-changing OSC will be logged, not sent',
    );
  }
}

await bootstrap();
