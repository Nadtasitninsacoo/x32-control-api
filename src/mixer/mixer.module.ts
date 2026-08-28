import { Module } from '@nestjs/common';
import { ConsoleModule } from '../console/console.module.js';
import { MixerController } from './mixer.controller.js';
import { MixerService } from './mixer.service.js';

/**
 * The mixer surface as a REST resource. Reads come from the console's state
 * mirror; writes go out as OSC in engineering units converted at the edge.
 */
@Module({
  imports: [ConsoleModule],
  controllers: [MixerController],
  providers: [MixerService],
  exports: [MixerService],
})
export class MixerModule {}
