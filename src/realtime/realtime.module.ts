import { Module } from '@nestjs/common';
import { ConsoleModule } from '../console/console.module.js';
import { MeteringModule } from '../metering/metering.module.js';
import { RealtimeGateway } from './realtime.gateway.js';

/** WebSocket push: meters and parameter changes. */
@Module({
  imports: [ConsoleModule, MeteringModule],
  providers: [RealtimeGateway],
  exports: [RealtimeGateway],
})
export class RealtimeModule {}
