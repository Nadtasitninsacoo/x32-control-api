import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../config/env.validation.js';
import { ConsoleConnection } from '../console/connection/console-connection.js';
import { OscArg } from '../osc/codec/osc-types.js';
import { OscPriority } from '../osc/rate-limit/osc-rate-limiter.js';
import {
  HumanValue,
  fromHuman,
  paramFor,
  toHuman,
} from '../osc/schema/x32-schema.js';
import { FaderMove, planFaderRamp } from './fader-ramp.js';

/**
 * Applies a set of desired values to a console.
 *
 * Two rules shape this, and both come from what a room hears rather than from
 * what is convenient to code:
 *
 * 1. **Send only what differs.** A preset recall that rewrites every parameter
 *    is thousands of datagrams the console will drop half of. The mirror
 *    already knows the current state, so the diff is free.
 * 2. **Walk levels, jump everything else.** A fader that snaps makes a click;
 *    a mute or an EQ frequency does not, and delaying those only makes the
 *    recall feel sluggish.
 */

export interface DesiredValue {
  readonly address: string;
  /** Value in API units. */
  readonly value: HumanValue;
}

export interface ValueChange {
  readonly address: string;
  readonly from: HumanValue | undefined;
  readonly to: HumanValue;
  /** True when this parameter is ramped rather than written once. */
  readonly ramped: boolean;
}

export interface ApplyOptions {
  /** Ramp time for level changes. Clamped to the configured safe window. */
  readonly rampMs?: number;
  /** Skip ramping entirely — for a panic recall, where speed is the point. */
  readonly immediate?: boolean;
}

export interface ApplyReport {
  readonly requested: number;
  readonly changed: number;
  readonly unchanged: number;
  readonly unknown: readonly string[];
  readonly rampedFaders: number;
  readonly stepsPerFader: number;
  readonly messages: number;
  readonly durationMs: number;
  readonly changes: readonly ValueChange[];
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

@Injectable()
export class ApplyService {
  private readonly logger = new Logger(ApplyService.name);

  constructor(private readonly config: ConfigService<EnvVars, true>) {}

  /**
   * Works out what would change, without sending anything.
   * Exposed on its own because "what will this preset do to my console" is a
   * question worth answering before the answer is audible.
   */
  diff(
    connection: ConsoleConnection,
    desired: readonly DesiredValue[],
  ): {
    changes: ValueChange[];
    unchanged: number;
    unknown: string[];
  } {
    const changes: ValueChange[] = [];
    const unknown: string[] = [];
    let unchanged = 0;

    for (const { address, value } of desired) {
      const def = paramFor(address);
      if (!def) {
        unknown.push(address);
        continue;
      }

      const current = connection.cache.getValue(address);
      // Compare in raw form: two dB values a hundredth apart are the same
      // console value, and re-sending them is wire time for nothing.
      const target = fromHuman(def, value);
      const currentRaw =
        current === undefined ? undefined : fromHuman(def, current);
      if (currentRaw !== undefined && sameArg(currentRaw, target)) {
        unchanged += 1;
        continue;
      }

      changes.push({
        address,
        from: current,
        to: toHuman(def, target),
        ramped: def.kind === 'level' && current !== undefined,
      });
    }

    return { changes, unchanged, unknown };
  }

  /** Applies the desired values, ramping levels. */
  async apply(
    connection: ConsoleConnection,
    desired: readonly DesiredValue[],
    options: ApplyOptions = {},
  ): Promise<ApplyReport> {
    const started = Date.now();
    const { changes, unchanged, unknown } = this.diff(connection, desired);

    const rampMs = options.immediate ? 0 : this.clampRamp(options.rampMs);
    const moves: FaderMove[] = changes
      .filter((change) => change.ramped)
      .map((change) => ({
        address: change.address,
        fromDb: Number(change.from ?? -90),
        toDb: Number(change.to),
      }));

    const plan =
      rampMs > 0 && moves.length > 0
        ? planFaderRamp(moves, {
            durationMs: rampMs,
            maxMessagesPerSecond: this.config.get('OSC_MAX_MSG_PER_SEC', {
              infer: true,
            }),
          })
        : undefined;

    let messages = 0;

    // Everything that cannot click goes out first: a recall should feel
    // instant, with only the levels arriving over the ramp.
    const rampedAddresses = new Set(
      plan ? moves.map((move) => move.address) : [],
    );
    for (const change of changes) {
      if (rampedAddresses.has(change.address)) continue;
      messages += await this.write(connection, change.address, change.to);
    }

    if (plan) {
      for (const move of plan.immediate) {
        messages += await this.write(connection, move.address, move.toDb);
      }

      let elapsed = 0;
      // Steps are grouped by time, so all faders move together rather than one
      // sweeping after another.
      for (const [atMs, group] of groupByTime(plan.steps)) {
        const wait = atMs - elapsed;
        if (wait > 0) await sleep(wait);
        elapsed = atMs;
        for (const step of group) {
          messages += await this.write(connection, step.address, step.db);
        }
      }

      if (plan.budgetLimited) {
        this.logger.warn(
          `ramp of ${moves.length} faders limited to ${plan.stepsPerFader} steps each by the ` +
            `${this.config.get('OSC_MAX_MSG_PER_SEC', { infer: true })} msg/s budget`,
        );
      }
    }

    const report: ApplyReport = {
      requested: desired.length,
      changed: changes.length,
      unchanged,
      unknown,
      rampedFaders: plan ? moves.length : 0,
      stepsPerFader: plan?.stepsPerFader ?? 0,
      messages,
      durationMs: Date.now() - started,
      changes,
    };

    this.logger.log(
      `${connection.id}: applied ${report.changed}/${report.requested} values ` +
        `(${report.unchanged} already correct) in ${report.messages} messages, ` +
        `${report.durationMs}ms`,
    );
    return report;
  }

  /** Keeps a caller-supplied ramp inside the window that actually sounds right. */
  private clampRamp(requested?: number): number {
    const min = this.config.get('RAMP_MIN_MS', { infer: true });
    const max = this.config.get('RAMP_MAX_MS', { infer: true });
    const value =
      requested ?? this.config.get('RAMP_DEFAULT_MS', { infer: true });
    return Math.min(max, Math.max(min, value));
  }

  private async write(
    connection: ConsoleConnection,
    address: string,
    value: HumanValue,
  ): Promise<number> {
    const def = paramFor(address);
    if (!def) return 0;
    const arg = fromHuman(def, value);
    await connection.osc.set(address, [arg], OscPriority.Command);
    connection.cache.set(address, [arg], 'local');
    return 1;
  }
}

function sameArg(a: OscArg, b: OscArg): boolean {
  if (a.type !== b.type) return false;
  if (a.type === 'b' && b.type === 'b') return a.value.equals(b.value);
  if (a.type === 'f' && b.type === 'f') {
    // float32 on the wire; anything closer than that is the same value.
    return Math.abs(a.value - b.value) < 1e-6;
  }
  return a.value === b.value;
}

function groupByTime(
  steps: readonly { address: string; db: number; atMs: number }[],
): [number, { address: string; db: number; atMs: number }[]][] {
  const groups = new Map<
    number,
    { address: string; db: number; atMs: number }[]
  >();
  for (const step of steps) {
    const group = groups.get(step.atMs);
    if (group) group.push(step);
    else groups.set(step.atMs, [step]);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]);
}
