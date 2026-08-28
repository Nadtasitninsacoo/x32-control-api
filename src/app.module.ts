import { Module } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { AuthGuard } from './auth/auth.guard.js';
import { AuthModule } from './auth/auth.module.js';
import { AuditInterceptor } from './safety/audit.interceptor.js';
import { ReadOnlyGuard } from './safety/read-only.guard.js';
import { SafetyModule } from './safety/safety.module.js';
import { validateEnv } from './config/env.validation.js';
import { ApplyModule } from './apply/apply.module.js';
import { ConsoleModule } from './console/console.module.js';
import { HealthModule } from './health/health.module.js';
import { MeteringModule } from './metering/metering.module.js';
import { MixerModule } from './mixer/mixer.module.js';
import { OscModule } from './osc/osc.module.js';
import { PresetModule } from './preset/preset.module.js';
import { RealtimeModule } from './realtime/realtime.module.js';
import { RoomEqModule } from './roomeq/roomeq.module.js';
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
    RoomEqModule,
    RealtimeModule,
    AuthModule,
    SafetyModule,
    HealthModule,
  ],
  providers: [
    // Order matters: establish who is asking before deciding whether the
    // system is accepting changes at all, and record it either way.
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: ReadOnlyGuard },
    { provide: APP_INTERCEPTOR, useClass: AuditInterceptor },
  ],
})
export class AppModule {}
