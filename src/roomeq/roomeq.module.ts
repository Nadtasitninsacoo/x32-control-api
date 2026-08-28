import { Module } from '@nestjs/common';
import { ApplyModule } from '../apply/apply.module.js';
import { ConsoleModule } from '../console/console.module.js';
import { RoomEqController } from './roomeq.controller.js';
import { RoomEqService } from './roomeq.service.js';

/** Room measurement in, PEQ bands out, and onto a bus if asked. */
@Module({
  imports: [ConsoleModule, ApplyModule],
  controllers: [RoomEqController],
  providers: [RoomEqService],
  exports: [RoomEqService],
})
export class RoomEqModule {}
