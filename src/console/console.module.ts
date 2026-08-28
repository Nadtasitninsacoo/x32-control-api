import { Module } from '@nestjs/common';
import { OscModule } from '../osc/osc.module.js';
import { ConsoleManagerService } from './console-manager.service.js';
import { ConsoleDiscoveryService } from './discovery/console-discovery.service.js';

/**
 * Console lifecycle: find them, stay connected to them, and mirror their
 * state. Everything above this layer asks the manager for a connection and
 * reads from its state cache rather than talking to a socket.
 */
@Module({
  imports: [OscModule],
  providers: [ConsoleManagerService, ConsoleDiscoveryService],
  exports: [ConsoleManagerService, ConsoleDiscoveryService],
})
export class ConsoleModule {}
