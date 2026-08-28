import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayConnection,
  OnGatewayDisconnect,
  SubscribeMessage,
  WebSocketGateway,
} from '@nestjs/websockets';
import { Socket } from 'socket.io';
import { EnvVars } from '../config/env.validation.js';
import { ConsoleManagerService } from '../console/console-manager.service.js';
import { StateChange } from '../console/state/state-cache.js';
import { MeteringService } from '../metering/metering.service.js';

export type StreamName = 'meters' | 'state';

export interface SubscribePayload {
  consoleId?: string;
  streams?: StreamName[];
}

export interface SubscribeAck {
  ok: boolean;
  consoleId?: string;
  streams?: StreamName[];
  error?: string;
}

const ALL_STREAMS: StreamName[] = ['meters', 'state'];

/**
 * Push channel for anything that changes faster than polling can follow:
 * meters, and parameter changes coming off the console's own surface.
 *
 * Both streams are opt-in per client and reference-counted, so a console is
 * only asked for meters while a client is actually watching them — the same
 * bandwidth an idle browser tab would otherwise waste is bandwidth the console
 * needs for operator commands.
 *
 * Parameter changes are batched on the same tick as meter frames rather than
 * sent one datagram at a time: recalling a scene changes hundreds of values at
 * once, and a client wants one message, not hundreds.
 */
@WebSocketGateway({ namespace: '/realtime', cors: { origin: '*' } })
export class RealtimeGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(RealtimeGateway.name);

  /** clientId -> stream key -> teardown */
  private readonly subscriptions = new Map<string, Map<string, () => void>>();

  constructor(
    private readonly consoles: ConsoleManagerService,
    private readonly meters: MeteringService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  handleConnection(client: Socket): void {
    this.subscriptions.set(client.id, new Map());
    client.emit('hello', {
      consoles: this.consoles
        .list()
        .map((status) => ({ id: status.id, state: status.state })),
      streams: ALL_STREAMS,
      meterFps: this.config.get('METER_FPS', { infer: true }),
    });
  }

  handleDisconnect(client: Socket): void {
    const streams = this.subscriptions.get(client.id);
    if (!streams) return;
    for (const teardown of streams.values()) teardown();
    this.subscriptions.delete(client.id);
  }

  @SubscribeMessage('subscribe')
  subscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SubscribePayload = {},
  ): SubscribeAck {
    const consoleId = payload.consoleId ?? 'default';
    const requested = payload.streams?.length ? payload.streams : ALL_STREAMS;

    const connection = this.consoles.get(consoleId);
    if (!connection) {
      return { ok: false, error: `no console with id "${consoleId}"` };
    }

    const opened: StreamName[] = [];
    for (const stream of requested) {
      if (!ALL_STREAMS.includes(stream)) {
        return { ok: false, error: `unknown stream "${stream}"` };
      }
      const key = `${consoleId}:${stream}`;
      const existing = this.subscriptions.get(client.id);
      if (!existing || existing.has(key)) continue;

      existing.set(
        key,
        stream === 'meters'
          ? this.openMeters(client, consoleId)
          : this.openState(client, consoleId),
      );
      opened.push(stream);
    }

    this.logger.log(
      `${client.id} subscribed to ${consoleId}: ${opened.join(', ') || '(already)'}`,
    );
    return { ok: true, consoleId, streams: requested };
  }

  @SubscribeMessage('unsubscribe')
  unsubscribe(
    @ConnectedSocket() client: Socket,
    @MessageBody() payload: SubscribePayload = {},
  ): SubscribeAck {
    const consoleId = payload.consoleId ?? 'default';
    const streams = payload.streams?.length ? payload.streams : ALL_STREAMS;
    const open = this.subscriptions.get(client.id);

    for (const stream of streams) {
      const key = `${consoleId}:${stream}`;
      const teardown = open?.get(key);
      if (!teardown) continue;
      teardown();
      open?.delete(key);
    }
    return { ok: true, consoleId, streams };
  }

  /** How many client subscriptions are open, for tests and diagnostics. */
  get subscriptionCount(): number {
    let total = 0;
    for (const streams of this.subscriptions.values()) total += streams.size;
    return total;
  }

  private openMeters(client: Socket, consoleId: string): () => void {
    return this.meters.listen(consoleId, (frame) => {
      client.emit('meters', frame);
    });
  }

  private openState(client: Socket, consoleId: string): () => void {
    const connection = this.consoles.require(consoleId);
    const batchMs = Math.round(
      1000 / this.config.get('METER_FPS', { infer: true }),
    );

    let pending = new Map<string, { address: string; value: unknown }>();
    const flush = (): void => {
      if (pending.size === 0) return;
      const changes = [...pending.values()];
      pending = new Map();
      client.emit('state', { consoleId, at: Date.now(), changes });
    };

    const timer = setInterval(flush, batchMs);
    timer.unref?.();

    const unsubscribeCache = connection.cache.subscribe(
      (change: StateChange) => {
        // Keyed by address: a fader being ridden for a second produces one
        // update per tick, not sixty.
        pending.set(change.address, {
          address: change.address,
          value: change.value,
        });
      },
    );

    const unsubscribeState = connection.onStateChange((state) => {
      client.emit('console', { consoleId, state });
    });

    return () => {
      clearInterval(timer);
      unsubscribeCache();
      unsubscribeState();
    };
  }
}
