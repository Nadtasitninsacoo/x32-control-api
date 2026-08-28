import { Module } from '@nestjs/common';
import { ConsoleModule } from '../console/console.module.js';
import { MeteringController } from './metering.controller.js';
import { MeteringService } from './metering.service.js';

/**
 * Meter subscription, decoding and rate control. The console is only asked for
 * meters while something is listening.
 */
@Module({
  imports: [ConsoleModule],
  controllers: [MeteringController],
  providers: [MeteringService],
  exports: [MeteringService],
})
export class MeteringModule {}
