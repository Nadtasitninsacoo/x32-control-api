import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { validateEnv } from './config/env.validation.js';
import { ApplyModule } from './apply/apply.module.js';
import { ConsoleModule } from './console/console.module.js';
import { HealthModule } from './health/health.module.js';
import { MeteringModule } from './metering/metering.module.js';
import { MixerModule } from './mixer/mixer.module.js';
import { OscModule } from './osc/osc.module.js';
import { PresetModule } from './preset/preset.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { SceneModule } from './scene/scene.module.js';

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
    ApplyModule,
    MixerModule,
    MeteringModule,
    SceneModule,
    PresetModule,
    RealtimeModule,
    HealthModule,
  ],
})
export class AppModule {}
