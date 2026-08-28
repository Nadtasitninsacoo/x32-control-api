import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  OscPriority,
  OscQueueOverflowError,
  OscRateLimiter,
  OscRateLimiterDisposedError,
} from './osc-rate-limiter.js';

interface Harness {
  limiter: OscRateLimiter<number>;
  sentAt: number[];
  sent: number[];
}

function harness(
  options: {
    maxPerSecond?: number;
    minGapMs?: number;
    maxQueueLength?: number;
  } = {},
): Harness {
  const sentAt: number[] = [];
  const sent: number[] = [];
  const limiter = new OscRateLimiter<number>(
    {
      maxPerSecond: options.maxPerSecond ?? 50,
      minGapMs: options.minGapMs ?? 2,
      maxQueueLength: options.maxQueueLength,
    },
    (job) => {
      sent.push(job);
      sentAt.push(Date.now());
    },
  );
  return { limiter, sentAt, sent };
}

/** Highest number of sends inside any 1000 ms window. */
function peakPerSecond(timestamps: number[]): number {
  let peak = 0;
  for (let start = 0; start < timestamps.length; start += 1) {
    let count = 0;
    while (
      start + count < timestamps.length &&
      timestamps[start + count] - timestamps[start] < 1000
    ) {
      count += 1;
    }
    peak = Math.max(peak, count);
  }
  return peak;
}

describe('OscRateLimiter', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('never sends synchronously from schedule()', () => {
    const { limiter, sent } = harness();
    void limiter.schedule(1);
    expect(sent).toEqual([]);
  });

  it('paces a 500-message burst without dropping any (acceptance criterion 5)', async () => {
    const { limiter, sent, sentAt } = harness({
      maxPerSecond: 50,
      minGapMs: 2,
    });

    const jobs = Array.from({ length: 500 }, (_, i) => limiter.schedule(i));
    await vi.advanceTimersByTimeAsync(20_000);
    await Promise.all(jobs);

    expect(sent).toHaveLength(500);
    expect(sent).toEqual(Array.from({ length: 500 }, (_, i) => i));
    expect(limiter.pendingCount).toBe(0);
    expect(limiter.stats.rejected).toBe(0);
    expect(limiter.stats.maxObservedQueueLength).toBe(500);

    expect(peakPerSecond(sentAt)).toBeLessThanOrEqual(50);
    for (let i = 1; i < sentAt.length; i += 1) {
      expect(sentAt[i] - sentAt[i - 1]).toBeGreaterThanOrEqual(2);
    }
    // 500 messages at 50/s cannot physically finish sooner than ~10s.
    expect(sentAt[sentAt.length - 1] - sentAt[0]).toBeGreaterThanOrEqual(9_000);
  });

  it('honours the minimum gap even when well under the rate ceiling', async () => {
    const { limiter, sentAt } = harness({ maxPerSecond: 1000, minGapMs: 5 });
    const jobs = Array.from({ length: 10 }, (_, i) => limiter.schedule(i));
    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(jobs);

    expect(sentAt).toHaveLength(10);
    for (let i = 1; i < sentAt.length; i += 1) {
      expect(sentAt[i] - sentAt[i - 1]).toBeGreaterThanOrEqual(5);
    }
  });

  it('sends an operator command ahead of queued polling traffic', async () => {
    const { limiter, sent } = harness({ maxPerSecond: 50, minGapMs: 2 });

    const queued = Array.from({ length: 20 }, (_, i) =>
      limiter.schedule(i, OscPriority.Polling),
    );
    const urgent = limiter.schedule(999, OscPriority.Command);

    await vi.advanceTimersByTimeAsync(5_000);
    await Promise.all([...queued, urgent]);

    // The first send was already committed when the command arrived; the
    // command must beat everything still waiting behind it.
    expect(sent.indexOf(999)).toBeLessThanOrEqual(1);
    expect(sent).toHaveLength(21);
  });

  it('keeps FIFO order within one priority', async () => {
    const { limiter, sent } = harness({ maxPerSecond: 1000, minGapMs: 0 });
    const jobs = [3, 1, 2].map((n) =>
      limiter.schedule(n, OscPriority.Housekeeping),
    );
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(jobs);
    expect(sent).toEqual([3, 1, 2]);
  });

  it('resolves each caller only once its own message has left', async () => {
    const { limiter, sent } = harness({ maxPerSecond: 1000, minGapMs: 10 });
    const order: string[] = [];
    const first = limiter.schedule(1).then(() => order.push('first'));
    const second = limiter.schedule(2).then(() => order.push('second'));

    await vi.advanceTimersByTimeAsync(5);
    expect(sent).toEqual([1]);

    await vi.advanceTimersByTimeAsync(50);
    await Promise.all([first, second]);
    expect(order).toEqual(['first', 'second']);
  });

  it('reports a rate limiter that is caught up', async () => {
    const { limiter } = harness({ maxPerSecond: 1000, minGapMs: 1 });
    const jobs = Array.from({ length: 5 }, (_, i) => limiter.schedule(i));
    const idle = limiter.onIdle();
    await vi.advanceTimersByTimeAsync(100);
    await Promise.all(jobs);
    await expect(idle).resolves.toBeUndefined();
    await expect(limiter.onIdle()).resolves.toBeUndefined();
  });

  it('rejects new work once the queue limit is reached, and counts it', async () => {
    const { limiter } = harness({
      maxPerSecond: 50,
      minGapMs: 2,
      maxQueueLength: 3,
    });
    const accepted = [
      limiter.schedule(1),
      limiter.schedule(2),
      limiter.schedule(3),
    ];
    await expect(limiter.schedule(4)).rejects.toBeInstanceOf(
      OscQueueOverflowError,
    );
    expect(limiter.stats.rejected).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await Promise.all(accepted);
  });

  it('surfaces a transport failure to the caller that queued the message', async () => {
    const limiter = new OscRateLimiter<number>(
      { maxPerSecond: 100, minGapMs: 1 },
      (job) => {
        if (job === 2) throw new Error('EHOSTUNREACH');
      },
    );
    // Attach the expectations before the timers run, so the rejection is
    // never momentarily unhandled.
    const first = expect(limiter.schedule(1)).resolves.toBeUndefined();
    const second = expect(limiter.schedule(2)).rejects.toThrow('EHOSTUNREACH');
    // One bad message must not stall the queue behind it.
    const third = expect(limiter.schedule(3)).resolves.toBeUndefined();

    await vi.advanceTimersByTimeAsync(100);
    await Promise.all([first, second, third]);
  });

  it('rejects everything still queued when disposed', async () => {
    const { limiter, sent } = harness({ maxPerSecond: 1, minGapMs: 2 });
    const first = limiter.schedule(1);
    const stranded = limiter.schedule(2);

    await vi.advanceTimersByTimeAsync(10);
    limiter.dispose();

    await expect(first).resolves.toBeUndefined();
    await expect(stranded).rejects.toBeInstanceOf(OscRateLimiterDisposedError);
    await expect(limiter.schedule(3)).rejects.toBeInstanceOf(
      OscRateLimiterDisposedError,
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(sent).toEqual([1]);
  });
});
