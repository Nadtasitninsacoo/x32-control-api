import { describe, expect, it } from 'vitest';
import { ExponentialBackoff } from './reconnect-policy.js';

describe('ExponentialBackoff', () => {
  it('doubles the delay and stops at the ceiling', () => {
    const backoff = new ExponentialBackoff({ minMs: 500, maxMs: 5000 });
    expect([
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
      backoff.next(),
    ]).toEqual([500, 1000, 2000, 4000, 5000, 5000]);
  });

  it('honours a custom factor', () => {
    const backoff = new ExponentialBackoff({
      minMs: 100,
      maxMs: 10_000,
      factor: 3,
    });
    expect([backoff.next(), backoff.next(), backoff.next()]).toEqual([
      100, 300, 900,
    ]);
  });

  it('keeps jittered delays inside the cap, never above it', () => {
    const backoff = new ExponentialBackoff(
      { minMs: 1000, maxMs: 4000, jitter: 0.5 },
      () => 1,
    );
    // Jitter only ever shortens the wait, so the ceiling stays a real bound.
    expect(backoff.next()).toBe(500);
    const generous = new ExponentialBackoff(
      { minMs: 1000, maxMs: 4000, jitter: 0.5 },
      () => 0,
    );
    expect(generous.next()).toBe(1000);
  });

  it('counts attempts and resets them', () => {
    const backoff = new ExponentialBackoff({ minMs: 200, maxMs: 2000 });
    backoff.next();
    backoff.next();
    expect(backoff.attempt).toBe(2);

    backoff.reset();
    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(200);
  });
});
