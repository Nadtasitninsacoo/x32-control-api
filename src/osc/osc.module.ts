import { Module } from '@nestjs/common';
import { OscClientFactory } from './client/osc-client.factory.js';
import { XRemoteHeartbeatService } from './heartbeat/xremote-heartbeat.service.js';

/**
 * The OSC layer: wire format, socket, pacing, request correlation and feed
 * renewal. It knows nothing about mixers, channels or dB — only how to move
 * OSC messages to and from a console safely.
 */
@Module({
  providers: [OscClientFactory, XRemoteHeartbeatService],
  exports: [OscClientFactory, XRemoteHeartbeatService],
})
export class OscModule {}
