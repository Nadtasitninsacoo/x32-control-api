import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation.js';
import { OscEndpoint } from '../transport/osc-transport.js';
import { OscClient, OscClientOptions } from './osc-client.js';

export interface CreateOscClientOptions extends Partial<
  Omit<OscClientOptions, 'id' | 'remote'>
> {
  readonly id: string;
  readonly remote: OscEndpoint;
}

/**
 * Builds console links with the pacing and timeout policy from configuration,
 * so no caller has to remember the safe values.
 */
@Injectable()
export class OscClientFactory {
  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  create(options: CreateOscClientOptions): OscClient {
    return new OscClient({
      maxPerSecond: this.config.get('OSC_MAX_MSG_PER_SEC', { infer: true }),
      minGapMs: this.config.get('OSC_MIN_GAP_MS', { infer: true }),
      maxQueueLength: this.config.get('OSC_MAX_QUEUE_LENGTH', { infer: true }),
      requestTimeoutMs: this.config.get('OSC_REQUEST_TIMEOUT_MS', {
        infer: true,
      }),
      localPort: this.config.get('OSC_LOCAL_PORT', { infer: true }),
      dryRun: this.config.get('DRY_RUN', { infer: true }),
      ...options,
    });
  }

  /** Default console endpoint from configuration, if one is configured. */
  get configuredEndpoint(): OscEndpoint | undefined {
    const host = this.config.get('X32_HOST', { infer: true });
    if (!host) return undefined;
    return { host, port: this.config.get('X32_PORT', { infer: true }) };
  }

  get broadcastAddress(): string {
    return this.config.get('OSC_BROADCAST_ADDRESS', { infer: true });
  }
}
