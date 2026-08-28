import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../../config/env.validation.js';
import { message } from '../../osc/codec/osc-codec.js';
import { argAsString } from '../../osc/codec/osc-types.js';
import { OscTransport } from '../../osc/transport/osc-transport.js';
import { DiscoveredConsole } from '../console.types.js';

export interface DiscoverOptions {
  /** Where to send the probe. Defaults to `OSC_BROADCAST_ADDRESS`. */
  readonly address?: string;
  readonly port?: number;
  /** How long to keep listening for answers. */
  readonly timeoutMs?: number;
}

/**
 * Finds consoles by shouting `/info` at the network and collecting whatever
 * answers.
 *
 * Two probes go out, ~150ms apart: UDP broadcast is lossy and a console that
 * misses the first one would otherwise stay invisible. Replies are keyed by
 * source address, so a second answer only refreshes an entry.
 */
@Injectable()
export class ConsoleDiscoveryService {
  private readonly logger = new Logger(ConsoleDiscoveryService.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  async discover(options: DiscoverOptions = {}): Promise<DiscoveredConsole[]> {
    const address =
      options.address ??
      this.config.get('OSC_BROADCAST_ADDRESS', { infer: true });
    const port = options.port ?? this.config.get('X32_PORT', { infer: true });
    const timeoutMs =
      options.timeoutMs ??
      this.config.get('DISCOVERY_TIMEOUT_MS', { infer: true });

    const transport = new OscTransport({
      remote: { host: address, port },
      broadcast: true,
      label: 'discovery',
    });

    const found = new Map<string, DiscoveredConsole>();
    const startedAt = Date.now();

    await transport.open();
    const unsubscribe = transport.onMessage((reply, from) => {
      if (reply.address !== '/info') return;
      const key = `${from.address}:${from.port}`;
      found.set(key, {
        host: from.address,
        port: from.port,
        serverVersion: argAsString(reply.args[0]) ?? '',
        name: argAsString(reply.args[1]) ?? '',
        model: argAsString(reply.args[2]) ?? '',
        firmware: argAsString(reply.args[3]) ?? '',
        rttMs: Date.now() - startedAt,
      });
    });

    try {
      const probe = message('/info');
      transport.send(probe);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min(150, timeoutMs / 2)),
      );
      transport.send(probe);
      await new Promise((resolve) => setTimeout(resolve, timeoutMs));
    } finally {
      unsubscribe();
      await transport.close();
    }

    const consoles = [...found.values()].sort((a, b) =>
      a.host.localeCompare(b.host),
    );
    this.logger.log(
      `discovery on ${address}:${port} found ${consoles.length} console(s)` +
        (consoles.length
          ? `: ${consoles.map((c) => `${c.name}@${c.host}`).join(', ')}`
          : ''),
    );
    return consoles;
  }
}
