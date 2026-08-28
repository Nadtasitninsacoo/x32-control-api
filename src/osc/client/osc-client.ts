import { Logger } from '@nestjs/common';
import { RemoteInfo } from 'node:dgram';
import { message } from '../codec/osc-codec.js';
import { OscArg, OscMessage } from '../codec/osc-types.js';
import {
  OscRequestBroker,
  OscRequestOptions,
} from '../broker/osc-request-broker.js';
import {
  OscPriority,
  OscRateLimiter,
  OscRateLimiterStats,
} from '../rate-limit/osc-rate-limiter.js';
import {
  OscEndpoint,
  OscMessageListener,
  OscTransport,
  OscTransportStats,
  Unsubscribe,
} from '../transport/osc-transport.js';

export const XREMOTE_ADDRESS = '/xremote';

export interface OscClientOptions {
  /** Stable id for this link; used as the log label and the consoleId. */
  readonly id: string;
  readonly remote: OscEndpoint;
  readonly localPort?: number;
  readonly localAddress?: string;
  readonly broadcast?: boolean;
  readonly dryRun?: boolean;
  readonly maxPerSecond: number;
  readonly minGapMs: number;
  readonly maxQueueLength?: number;
  readonly requestTimeoutMs: number;
}

export interface OscClientStats {
  readonly transport: OscTransportStats;
  readonly queue: OscRateLimiterStats;
  readonly pendingRequests: number;
}

/**
 * A single console link: socket + pacing + request correlation.
 *
 * Everything that talks to a console goes through one of these. One instance
 * per consoleId, created by {@link OscClientFactory}.
 */
export class OscClient {
  private readonly logger: Logger;
  private readonly transport: OscTransport;
  private readonly limiter: OscRateLimiter<{
    message: OscMessage;
    target?: OscEndpoint;
  }>;
  private readonly broker: OscRequestBroker;
  private readonly listeners = new Set<OscMessageListener>();
  private unsubscribeTransport: Unsubscribe | undefined;

  constructor(private readonly options: OscClientOptions) {
    this.logger = new Logger(`OscClient:${options.id}`);
    this.transport = new OscTransport({
      remote: options.remote,
      localPort: options.localPort,
      localAddress: options.localAddress,
      broadcast: options.broadcast,
      dryRun: options.dryRun,
      label: options.id,
    });
    this.limiter = new OscRateLimiter(
      {
        maxPerSecond: options.maxPerSecond,
        minGapMs: options.minGapMs,
        maxQueueLength: options.maxQueueLength,
      },
      ({ message: msg, target }) => this.transport.send(msg, target),
    );
    this.broker = new OscRequestBroker(
      (msg, priority) => this.limiter.schedule({ message: msg }, priority),
      { timeoutMs: options.requestTimeoutMs, label: options.id },
    );
  }

  get id(): string {
    return this.options.id;
  }

  get remote(): OscEndpoint {
    return this.transport.remote;
  }

  get isOpen(): boolean {
    return this.transport.isOpen;
  }

  get stats(): OscClientStats {
    return {
      transport: this.transport.stats,
      queue: this.limiter.stats,
      pendingRequests: this.broker.pendingCount,
    };
  }

  async open(): Promise<void> {
    if (this.transport.isOpen) return;
    await this.transport.open();
    this.unsubscribeTransport = this.transport.onMessage((msg, from) =>
      this.handleMessage(msg, from),
    );
  }

  async close(): Promise<void> {
    this.unsubscribeTransport?.();
    this.unsubscribeTransport = undefined;
    this.broker.abortAll();
    this.limiter.dispose();
    await this.transport.close();
  }

  /** Fire-and-forget, paced. Resolves once the datagram has left. */
  send(
    msg: OscMessage,
    priority: OscPriority = OscPriority.Command,
    target?: OscEndpoint,
  ): Promise<void> {
    return this.limiter.schedule({ message: msg, target }, priority);
  }

  /** Sends a message and waits for the console's reply. */
  request(msg: OscMessage, options?: OscRequestOptions): Promise<OscMessage> {
    return this.broker.request(msg, options);
  }

  /** Reads one parameter: an argument-less message is a query on the X32. */
  get(address: string, options?: OscRequestOptions): Promise<OscMessage> {
    return this.request(message(address), options);
  }

  /** Writes one parameter. */
  set(
    address: string,
    args: OscArg[],
    priority: OscPriority = OscPriority.Command,
  ): Promise<void> {
    return this.send({ address, args }, priority);
  }

  /**
   * `/node` returns a whole subtree as one text line; the console answers on
   * the bare address `node`, not on `/node`.
   */
  nodeQuery(path: string, options?: OscRequestOptions): Promise<OscMessage> {
    return this.request(message('/node', { type: 's', value: path }), {
      replyAddress: 'node',
      priority: OscPriority.Polling,
      ...options,
    });
  }

  /** Renews the 10-second parameter-feed subscription. */
  sendXRemote(): Promise<void> {
    return this.send(message(XREMOTE_ADDRESS), OscPriority.Housekeeping);
  }

  /** Every inbound message, including replies already matched by the broker. */
  onMessage(listener: OscMessageListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Waits for the send queue to drain — mainly useful in tests. */
  onIdle(): Promise<void> {
    return this.limiter.onIdle();
  }

  private handleMessage(msg: OscMessage, from: RemoteInfo): void {
    this.broker.handleMessage(msg);
    for (const listener of this.listeners) {
      try {
        listener(msg, from);
      } catch (error) {
        this.logger.warn(
          `listener threw on ${msg.address}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}
