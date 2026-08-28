import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SchedulerRegistry } from '@nestjs/schedule';
import { EnvVars } from '../../config/env.validation.js';
import { OscClient } from '../client/osc-client.js';

const INTERVAL_NAME = 'xremote-heartbeat';

/**
 * Keeps the console's parameter feed alive.
 *
 * `/xremote` subscribes this client to every parameter change for **10
 * seconds**. Miss the renewal and the feed goes silent with no error and no
 * notification — the mirrored state simply starts drifting from reality. The
 * default 8s period leaves one full period of margin for a lost datagram.
 */
@Injectable()
export class XRemoteHeartbeatService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(XRemoteHeartbeatService.name);
  private readonly clients = new Map<string, OscClient>();
  private started = false;

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly scheduler: SchedulerRegistry,
  ) {}

  get intervalMs(): number {
    return this.config.get('XREMOTE_INTERVAL_MS', { infer: true });
  }

  get registeredIds(): string[] {
    return [...this.clients.keys()];
  }

  onModuleInit(): void {
    if (this.started) return;
    const interval = setInterval(() => {
      void this.tick();
    }, this.intervalMs);
    interval.unref?.();
    this.scheduler.addInterval(INTERVAL_NAME, interval);
    this.started = true;
    this.logger.log(`/xremote renewal every ${this.intervalMs}ms`);
  }

  onModuleDestroy(): void {
    if (!this.started) return;
    this.scheduler.deleteInterval(INTERVAL_NAME);
    this.started = false;
    this.clients.clear();
  }

  /** Starts renewing the feed for this link, and subscribes immediately. */
  register(client: OscClient): void {
    this.clients.set(client.id, client);
    void this.renew(client);
  }

  unregister(consoleId: string): void {
    this.clients.delete(consoleId);
  }

  /** Exposed for tests: performs one renewal round. */
  async tick(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map((client) => this.renew(client)),
    );
  }

  private async renew(client: OscClient): Promise<void> {
    if (!client.isOpen) return;
    try {
      await client.sendXRemote();
    } catch (error) {
      this.logger.warn(
        `/xremote renewal failed for ${client.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}
