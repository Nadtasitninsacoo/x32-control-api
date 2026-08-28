/**
 * Exponential backoff for reconnect attempts.
 *
 * The ceiling matters more than the growth rate here: a console that comes
 * back after a switch reboot must be picked up quickly, so the delay is capped
 * low (5s by default) rather than allowed to grow into minutes. Jitter keeps
 * several consoles from retrying in lockstep after a site-wide outage.
 */

export interface BackoffOptions {
  readonly minMs: number;
  readonly maxMs: number;
  readonly factor?: number;
  /** Fraction of the delay to randomise, 0..1. */
  readonly jitter?: number;
}

export class ExponentialBackoff {
  private attempts = 0;

  constructor(
    private readonly options: BackoffOptions,
    private readonly random: () => number = Math.random,
  ) {}

  get attempt(): number {
    return this.attempts;
  }

  /** Delay for the next attempt, in milliseconds. */
  next(): number {
    const factor = this.options.factor ?? 2;
    const raw = this.options.minMs * factor ** this.attempts;
    const capped = Math.min(raw, this.options.maxMs);
    this.attempts += 1;

    const jitter = this.options.jitter ?? 0;
    if (jitter <= 0) return Math.round(capped);

    // Jitter downwards only, so the cap stays a real upper bound.
    const spread = capped * jitter;
    return Math.round(capped - spread * this.random());
  }

  reset(): void {
    this.attempts = 0;
  }
}
