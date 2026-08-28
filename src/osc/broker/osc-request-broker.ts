import { Logger } from '@nestjs/common';
import { formatMessage } from '../codec/osc-codec.js';
import { OscMessage } from '../codec/osc-types.js';
import { OscPriority } from '../rate-limit/osc-rate-limiter.js';

/**
 * Correlates requests with replies on a protocol that has no request ids.
 *
 * The X32 answers a query by echoing the *same address* back with the current
 * value (`/ch/01/mix/fader` -> `/ch/01/mix/fader ,f 0.6`), with one exception:
 * a `/node` query is answered on the bare address `node`. There is nothing
 * else to match on, so pending requests are keyed by address and served FIFO.
 *
 * Consequence worth knowing: while a request for an address is in flight, an
 * unsolicited /xremote update for that same address will satisfy it. The value
 * is current either way, so this is harmless — but it does mean a reply is
 * "the next message on this address", not "the answer to my message".
 */

export interface OscRequestOptions {
  /** Address the reply will arrive on. Defaults to the request address. */
  readonly replyAddress?: string;
  readonly timeoutMs?: number;
  readonly priority?: OscPriority;
}

export interface OscRequestBrokerOptions {
  readonly timeoutMs: number;
  readonly label?: string;
}

export class OscRequestTimeoutError extends Error {
  constructor(
    readonly address: string,
    readonly timeoutMs: number,
  ) {
    super(`no reply on "${address}" within ${timeoutMs}ms`);
    this.name = 'OscRequestTimeoutError';
  }
}

export class OscRequestAbortedError extends Error {
  constructor(readonly address: string) {
    super(`request on "${address}" was aborted`);
    this.name = 'OscRequestAbortedError';
  }
}

interface PendingRequest {
  readonly address: string;
  readonly resolve: (message: OscMessage) => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
}

/** `/node` replies arrive without a leading slash; normalise both forms. */
function normalizeAddress(address: string): string {
  return address.startsWith('/') ? address.slice(1) : address;
}

export class OscRequestBroker {
  private readonly logger: Logger;
  private readonly pending = new Map<string, PendingRequest[]>();

  constructor(
    /** Hands the message to the paced sender. */
    private readonly send: (
      message: OscMessage,
      priority: OscPriority,
    ) => Promise<void>,
    private readonly options: OscRequestBrokerOptions,
  ) {
    this.logger = new Logger(
      `OscRequestBroker${options.label ? `:${options.label}` : ''}`,
    );
  }

  get pendingCount(): number {
    let total = 0;
    for (const queue of this.pending.values()) total += queue.length;
    return total;
  }

  async request(
    message: OscMessage,
    options: OscRequestOptions = {},
  ): Promise<OscMessage> {
    const replyAddress = normalizeAddress(
      options.replyAddress ?? message.address,
    );
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs;

    const reply = new Promise<OscMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.remove(replyAddress, entry);
        reject(new OscRequestTimeoutError(replyAddress, timeoutMs));
      }, timeoutMs);
      timer.unref?.();

      const entry: PendingRequest = {
        address: replyAddress,
        resolve,
        reject,
        timer,
      };
      const queue = this.pending.get(replyAddress);
      if (queue) queue.push(entry);
      else this.pending.set(replyAddress, [entry]);
    });

    try {
      await this.send(message, options.priority ?? OscPriority.Command);
    } catch (error) {
      // Fail through the same promise the caller is holding, so a send error
      // never surfaces as a second, unobserved rejection.
      this.rejectNext(
        replyAddress,
        error instanceof Error ? error : new Error(String(error)),
      );
    }

    return reply;
  }

  /**
   * Offer an inbound message to the broker.
   * @returns true if it satisfied a pending request (callers may still want to
   *          feed it to the state cache — the X32 feed is a broadcast, not a
   *          point-to-point response, so both consumers are legitimate).
   */
  handleMessage(message: OscMessage): boolean {
    const key = normalizeAddress(message.address);
    const queue = this.pending.get(key);
    if (!queue || queue.length === 0) return false;

    const entry = queue.shift();
    if (queue.length === 0) this.pending.delete(key);
    if (!entry) return false;

    clearTimeout(entry.timer);
    entry.resolve(message);
    return true;
  }

  /** Fails every in-flight request; used when the link drops. */
  abortAll(reason?: Error): void {
    const queues = [...this.pending.values()];
    this.pending.clear();
    for (const queue of queues) {
      for (const entry of queue) {
        clearTimeout(entry.timer);
        entry.reject(reason ?? new OscRequestAbortedError(entry.address));
      }
    }
  }

  private remove(address: string, entry: PendingRequest): void {
    const queue = this.pending.get(address);
    if (!queue) return;
    const index = queue.indexOf(entry);
    if (index >= 0) queue.splice(index, 1);
    if (queue.length === 0) this.pending.delete(address);
  }

  private rejectNext(address: string, error: Error): void {
    const queue = this.pending.get(address);
    const entry = queue?.pop();
    if (!entry) return;
    clearTimeout(entry.timer);
    if (queue && queue.length === 0) this.pending.delete(address);
    this.logger.debug(
      `send failed for ${formatMessage({ address, args: [] })}: ${error.message}`,
    );
    entry.reject(error);
  }
}
