/**
 * Outbound pacing for a single console link.
 *
 * The X32 silently drops UDP packets when it is flooded — there is no flow
 * control and no NAK, the parameter change simply never happens. So every
 * outgoing datagram passes through this queue, which enforces both a
 * sustained rate ceiling and a minimum inter-packet gap.
 *
 * The queue never discards work: a burst of 500 commands is spread out over
 * time rather than dropped (unless the caller sets `maxQueueLength`, which is
 * a backpressure escape hatch for runaway producers).
 */

export enum OscPriority {
  /** Operator-initiated commands: fader moves, mutes, preset recalls. */
  Command = 0,
  /** Housekeeping: /xremote renewals, meter subscription renewals. */
  Housekeeping = 1,
  /** Bulk background work: initial state sync, /node sweeps. */
  Polling = 2,
}

const PRIORITIES = [
  OscPriority.Command,
  OscPriority.Housekeeping,
  OscPriority.Polling,
];

export interface OscRateLimiterOptions {
  /** Sustained ceiling; the console starts dropping well above this. */
  readonly maxPerSecond: number;
  /** Hard floor on the gap between two consecutive datagrams. */
  readonly minGapMs: number;
  /** Reject new work beyond this depth. 0 (default) means unbounded. */
  readonly maxQueueLength?: number;
}

export interface OscRateLimiterStats {
  readonly sent: number;
  readonly queued: number;
  readonly rejected: number;
  readonly maxObservedQueueLength: number;
}

export class OscQueueOverflowError extends Error {
  constructor(limit: number) {
    super(`OSC send queue is full (${limit} pending)`);
    this.name = 'OscQueueOverflowError';
  }
}

export class OscRateLimiterDisposedError extends Error {
  constructor() {
    super('OSC rate limiter was disposed before the message could be sent');
    this.name = 'OscRateLimiterDisposedError';
  }
}

interface QueueEntry<T> {
  readonly job: T;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

export class OscRateLimiter<T = unknown> {
  private readonly queues = new Map<OscPriority, QueueEntry<T>[]>(
    PRIORITIES.map((p) => [p, [] as QueueEntry<T>[]]),
  );

  /** Timestamps of the sends inside the current sliding second. */
  private readonly window: number[] = [];

  private readonly idleWaiters: (() => void)[] = [];

  private timer: NodeJS.Timeout | undefined;
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  private sent = 0;
  private rejected = 0;
  private maxObservedQueueLength = 0;

  constructor(
    private readonly options: OscRateLimiterOptions,
    /** Performs the actual send. Errors reject the caller's promise. */
    private readonly sender: (job: T) => void,
    private readonly now: () => number = () => Date.now(),
  ) {}

  get pendingCount(): number {
    let total = 0;
    for (const queue of this.queues.values()) total += queue.length;
    return total;
  }

  get stats(): OscRateLimiterStats {
    return {
      sent: this.sent,
      queued: this.pendingCount,
      rejected: this.rejected,
      maxObservedQueueLength: this.maxObservedQueueLength,
    };
  }

  /**
   * Queue one job. The returned promise settles when the job has actually been
   * handed to the transport — callers that need send ordering can await it.
   */
  schedule(job: T, priority: OscPriority = OscPriority.Command): Promise<void> {
    if (this.disposed) {
      return Promise.reject(new OscRateLimiterDisposedError());
    }
    const limit = this.options.maxQueueLength ?? 0;
    if (limit > 0 && this.pendingCount >= limit) {
      this.rejected += 1;
      return Promise.reject(new OscQueueOverflowError(limit));
    }
    return new Promise<void>((resolve, reject) => {
      this.queueFor(priority).push({ job, resolve, reject });
      this.maxObservedQueueLength = Math.max(
        this.maxObservedQueueLength,
        this.pendingCount,
      );
      this.kick();
    });
  }

  /** Resolves once the queue has fully drained. */
  onIdle(): Promise<void> {
    if (this.pendingCount === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  /** Cancels everything still queued and stops the drain timer. */
  dispose(): void {
    this.disposed = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    for (const queue of this.queues.values()) {
      const pending = queue.splice(0, queue.length);
      for (const entry of pending)
        entry.reject(new OscRateLimiterDisposedError());
    }
    this.releaseIdleWaiters();
  }

  private queueFor(priority: OscPriority): QueueEntry<T>[] {
    const queue = this.queues.get(priority);
    if (queue) return queue;
    const created: QueueEntry<T>[] = [];
    this.queues.set(priority, created);
    return created;
  }

  private takeNext(): QueueEntry<T> | undefined {
    for (const priority of PRIORITIES) {
      const queue = this.queues.get(priority);
      if (queue && queue.length > 0) return queue.shift();
    }
    return undefined;
  }

  /** Milliseconds until the next send is permitted; 0 means "right now". */
  private delayUntilNextSlot(): number {
    const now = this.now();
    const gapWait = Math.max(0, this.lastSentAt + this.options.minGapMs - now);

    const windowStart = now - 1000;
    while (this.window.length > 0 && this.window[0] <= windowStart)
      this.window.shift();
    const rateWait =
      this.window.length >= this.options.maxPerSecond
        ? Math.max(0, this.window[0] + 1000 - now)
        : 0;

    return Math.max(gapWait, rateWait);
  }

  private releaseIdleWaiters(): void {
    const waiters = this.idleWaiters.splice(0, this.idleWaiters.length);
    for (const resolve of waiters) resolve();
  }

  private kick(): void {
    if (this.timer !== undefined || this.disposed || this.pendingCount === 0)
      return;
    // Always go through a timer, never a synchronous loop: draining 500 queued
    // messages inline would starve the event loop that feeds the socket.
    this.timer = setTimeout(() => this.drain(), this.delayUntilNextSlot());
    this.timer.unref?.();
  }

  private drain(): void {
    this.timer = undefined;
    if (this.disposed) return;

    if (this.delayUntilNextSlot() > 0) {
      this.kick();
      return;
    }

    const entry = this.takeNext();
    if (entry) {
      const now = this.now();
      this.lastSentAt = now;
      this.window.push(now);
      this.sent += 1;
      try {
        this.sender(entry.job);
        entry.resolve();
      } catch (error) {
        entry.reject(error instanceof Error ? error : new Error(String(error)));
      }
    }
    if (this.pendingCount === 0) this.releaseIdleWaiters();
    this.kick();
  }
}
