import { Module } from '@nestjs/common';
import { ApplyService } from './apply.service.js';

/**
 * Turning a set of desired values into console traffic: diff first, ramp
 * levels, send the rest immediately. Shared by scene import and venue presets.
 */
@Module({
  providers: [ApplyService],
  exports: [ApplyService],
})
export class ApplyModule {}
