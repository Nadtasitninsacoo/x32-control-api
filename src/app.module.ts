import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnv } from './config/env.validation.js';
import { ConsoleModule } from './console/console.module.js';
import { HealthModule } from './health/health.module.js';
import { MixerModule } from './mixer/mixer.module.js';
import { OscModule } from './osc/osc.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      cache: true,
      validate: validateEnv,
      envFilePath: ['.env'],
    }),
    ScheduleModule.forRoot(),
    OscModule,
    ConsoleModule,
    MixerModule,
    HealthModule,
  ],
})
export class AppModule {}
