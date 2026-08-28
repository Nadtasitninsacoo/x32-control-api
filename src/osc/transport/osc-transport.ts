import { createSocket, RemoteInfo, Socket } from 'node:dgram';
import { Logger } from '@nestjs/common';
import {
  assertOutboundAddress,
  decodeMessages,
  encodeMessage,
  formatMessage,
} from '../codec/osc-codec.js';
import { OscMessage } from '../codec/osc-types.js';

export interface OscEndpoint {
  readonly host: string;
  readonly port: number;
}

export interface OscTransportOptions {
  /** Console address; datagrams are sent here unless a call overrides it. */
  readonly remote: OscEndpoint;
  /** Local UDP port to bind. 0 (default) lets the OS pick one. */
  readonly localPort?: number;
  /** Local interface to bind. Undefined binds all interfaces. */
  readonly localAddress?: string;
  /** Enable SO_BROADCAST — required for the 255.255.255.255 /info sweep. */
  readonly broadcast?: boolean;
  /**
   * When true, messages that would *change* console state are logged instead
   * of sent. Queries (messages with no arguments) still go out, so the UI can
   * be exercised against a live console without touching a single parameter.
   */
  readonly dryRun?: boolean;
  /** Label used in logs; usually the consoleId. */
  readonly label?: string;
}

export type OscMessageListener = (
  message: OscMessage,
  from: RemoteInfo,
) => void;
export type OscErrorListener = (error: Error) => void;

/** Unsubscribe handle returned by the `on*` methods. */
export type Unsubscribe = () => void;

export interface OscTransportStats {
  readonly sent: number;
  readonly received: number;
  readonly suppressed: number;
  readonly decodeErrors: number;
  readonly localPort: number | undefined;
}

export class OscTransportClosedError extends Error {
  constructor() {
    super('OSC transport is not open');
    this.name = 'OscTransportClosedError';
  }
}

/**
 * One UDP socket to one console. Deliberately dumb: no retries, no pacing, no
 * request matching — those live in {@link OscRateLimiter} and
 * {@link OscRequestBroker} so each concern can be tested on its own.
 */
export class OscTransport {
  private readonly logger: Logger;
  private socket: Socket | undefined;
  private readonly messageListeners = new Set<OscMessageListener>();
  private readonly errorListeners = new Set<OscErrorListener>();

  private sentCount = 0;
  private receivedCount = 0;
  private suppressedCount = 0;
  private decodeErrorCount = 0;

  constructor(private readonly options: OscTransportOptions) {
    this.logger = new Logger(
      `OscTransport${options.label ? `:${options.label}` : ''}`,
    );
  }

  get isOpen(): boolean {
    return this.socket !== undefined;
  }

  get remote(): OscEndpoint {
    return this.options.remote;
  }

  get stats(): OscTransportStats {
    return {
      sent: this.sentCount,
      received: this.receivedCount,
      suppressed: this.suppressedCount,
      decodeErrors: this.decodeErrorCount,
      localPort: this.socket?.address().port,
    };
  }

  async open(): Promise<void> {
    if (this.socket) return;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });

    socket.on('message', (data, from) => this.handleDatagram(data, from));
    socket.on('error', (error) => {
      this.emitError(error);
    });

    await new Promise<void>((resolve, reject) => {
      const onBindError = (error: Error): void => reject(error);
      socket.once('error', onBindError);
      socket.bind(
        {
          port: this.options.localPort ?? 0,
          address: this.options.localAddress,
        },
        () => {
          socket.off('error', onBindError);
          resolve();
        },
      );
    });

    if (this.options.broadcast) socket.setBroadcast(true);
    this.socket = socket;
    this.logger.log(
      `bound udp4 ${this.options.localAddress ?? '0.0.0.0'}:${socket.address().port} -> ` +
        `${this.options.remote.host}:${this.options.remote.port}` +
        (this.options.dryRun ? ' [DRY_RUN]' : ''),
    );
  }

  async close(): Promise<void> {
    const socket = this.socket;
    this.socket = undefined;
    if (!socket) return;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
    this.logger.log('socket closed');
  }

  /**
   * Send one message immediately. Callers on the hot path should go through
   * the rate limiter instead of calling this directly.
   */
  send(message: OscMessage, target: OscEndpoint = this.options.remote): void {
    const socket = this.socket;
    if (!socket) throw new OscTransportClosedError();
    assertOutboundAddress(message.address);

    if (this.options.dryRun && message.args.length > 0) {
      this.suppressedCount += 1;
      this.logger.log(`DRY_RUN suppressed -> ${formatMessage(message)}`);
      return;
    }

    const payload = encodeMessage(message);
    socket.send(payload, target.port, target.host, (error) => {
      if (error) this.emitError(error);
    });
    this.sentCount += 1;
  }

  onMessage(listener: OscMessageListener): Unsubscribe {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onError(listener: OscErrorListener): Unsubscribe {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private handleDatagram(data: Buffer, from: RemoteInfo): void {
    let messages: OscMessage[];
    try {
      messages = decodeMessages(data);
    } catch (error) {
      // A malformed datagram must never take the process down: the console
      // firmware does emit the occasional oddity, and so do other devices
      // that happen to answer a broadcast.
      this.decodeErrorCount += 1;
      this.logger.warn(
        `dropped undecodable datagram from ${from.address}:${from.port}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      return;
    }
    this.receivedCount += messages.length;
    for (const message of messages) {
      for (const listener of this.messageListeners) {
        try {
          listener(message, from);
        } catch (error) {
          this.emitError(
            error instanceof Error ? error : new Error(String(error)),
          );
        }
      }
    }
  }

  private emitError(error: Error): void {
    if (this.errorListeners.size === 0) {
      this.logger.error(error.message);
      return;
    }
    for (const listener of this.errorListeners) listener(error);
  }
}
