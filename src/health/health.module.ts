import { Module } from '@nestjs/common';
import { ConsoleModule } from '../console/console.module.js';
import { HealthController } from './health.controller.js';

@Module({
  imports: [ConsoleModule],
  controllers: [HealthController],
})
export class HealthModule {}
