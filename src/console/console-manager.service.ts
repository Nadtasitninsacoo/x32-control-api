import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../config/env.validation.js';
import { OscClientFactory } from '../osc/client/osc-client.factory.js';
import { XRemoteHeartbeatService } from '../osc/heartbeat/xremote-heartbeat.service.js';
import { ConsoleConnection } from './connection/console-connection.js';
import { ConsoleInfo, ConsoleStatus, SyncDepth } from './console.types.js';

export interface ConnectConsoleOptions {
  readonly host: string;
  readonly port?: number;
  /** Defaults to `default` for the first console, then the host address. */
  readonly id?: string;
  readonly syncDepth?: SyncDepth;
}

export const DEFAULT_CONSOLE_ID = 'default';

/**
 * Owns every console link in the process, keyed by consoleId.
 *
 * Multiple consoles are a first-class case (a monitor desk and a FOH desk on
 * the same network), so nothing here assumes a single link — the "default"
 * id is only the one auto-connected from configuration at boot.
 */
@Injectable()
export class ConsoleManagerService
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ConsoleManagerService.name);
  private readonly connections = new Map<string, ConsoleConnection>();

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly clients: OscClientFactory,
    private readonly heartbeat: XRemoteHeartbeatService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    if (!this.config.get('CONSOLE_AUTO_CONNECT', { infer: true })) return;
    const endpoint = this.clients.configuredEndpoint;
    if (!endpoint) {
      this.logger.log('X32_HOST is not set — no console connected at boot');
      return;
    }
    try {
      await this.connect({
        host: endpoint.host,
        port: endpoint.port,
        id: DEFAULT_CONSOLE_ID,
      });
    } catch (error) {
      // A console that is off at boot is normal; the link is created anyway
      // and keeps retrying, so this must never stop the API from starting.
      this.logger.warn(
        `could not reach ${endpoint.host}:${endpoint.port} at boot: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.connections.keys()].map((id) => this.disconnect(id)),
    );
  }

  list(): ConsoleStatus[] {
    return [...this.connections.values()].map((connection) =>
      connection.status(),
    );
  }

  get(id: string): ConsoleConnection | undefined {
    return this.connections.get(id);
  }

  /** The connection, or a 404 — the shape controllers want. */
  require(id: string): ConsoleConnection {
    const connection = this.connections.get(id);
    if (!connection) throw new NotFoundException(`no console with id "${id}"`);
    return connection;
  }

  async connect(options: ConnectConsoleOptions): Promise<ConsoleInfo> {
    const id =
      options.id ??
      (this.connections.size === 0 ? DEFAULT_CONSOLE_ID : options.host);
    if (this.connections.has(id)) {
      throw new ConflictException(`console "${id}" is already connected`);
    }

    const endpoint = {
      host: options.host,
      port: options.port ?? this.config.get('X32_PORT', { infer: true }),
    };

    const connection = new ConsoleConnection(
      {
        id,
        endpoint,
        probeIntervalMs: this.config.get('CONSOLE_PROBE_INTERVAL_MS', {
          infer: true,
        }),
        probeTimeoutMs: this.config.get('CONSOLE_PROBE_TIMEOUT_MS', {
          infer: true,
        }),
        maxMissedProbes: this.config.get('CONSOLE_MAX_MISSED_PROBES', {
          infer: true,
        }),
        reconnect: {
          minMs: this.config.get('CONSOLE_RECONNECT_MIN_MS', { infer: true }),
          maxMs: this.config.get('CONSOLE_RECONNECT_MAX_MS', { infer: true }),
          jitter: 0.2,
        },
        syncDepth:
          options.syncDepth ??
          this.config.get('CONSOLE_SYNC_DEPTH', { infer: true }),
        dryRun: this.config.get('DRY_RUN', { infer: true }),
      },
      this.clients.create({ id, remote: endpoint }),
      this.heartbeat,
    );

    // Registered before the first contact attempt: the caller asked for this
    // console, so a link that is merely unreachable right now stays in the
    // registry (visible as `disconnected`) instead of vanishing.
    this.connections.set(id, connection);
    const info = await connection.connect();
    this.logger.log(
      `connected "${id}" -> ${info.model} "${info.name}" fw ${info.firmware}`,
    );
    return info;
  }

  async disconnect(id: string): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    this.connections.delete(id);
    await connection.disconnect();
    this.logger.log(`disconnected "${id}"`);
  }
}
