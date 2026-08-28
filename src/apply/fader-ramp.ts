import { levelDbToFloat, levelFloatToDb } from '../osc/units/x32-units.js';

/**
 * Fader ramping.
 *
 * A fader that jumps straight to its new position makes an audible click, and
 * a preset recall that moves twenty of them at once makes twenty of them. So a
 * level change is walked to its target over a few hundred milliseconds instead.
 *
 * The interesting constraint is that the ramp has to fit through the same
 * ~50 messages per second the console tolerates. Twenty faders ramped in twenty
 * steps each is 400 datagrams — eight seconds of wire time, which is not a ramp,
 * it is a slow fade nobody asked for, and it starves operator commands while it
 * runs. So the plan is *budgeted*: the number of steps per fader is derived
 * from how many faders are moving and how much wire time the ramp is allowed,
 * and a move too small to click is simply sent once.
 *
 * Interpolation is in fader *position*, not in dB. The console's dB taper is
 * piecewise, and a physical fader moves linearly in position — travelling in
 * position is what a hand on the fader sounds like.
 */

export interface FaderMove {
  readonly address: string;
  readonly fromDb: number;
  readonly toDb: number;
}

export interface RampStep {
  readonly address: string;
  readonly db: number;
  /** Milliseconds from the start of the ramp. */
  readonly atMs: number;
  /** True for the step that lands exactly on the target. */
  readonly final: boolean;
}

export interface RampOptions {
  /** Total ramp time. The spec's 300-800 ms window is the useful range. */
  readonly durationMs: number;
  /** Message budget per second — the console's tolerance, not ours. */
  readonly maxMessagesPerSecond: number;
  /** Changes smaller than this are sent as one message; they cannot click. */
  readonly minRampDb?: number;
  /** Hard ceiling on steps per fader, however much budget there is. */
  readonly maxStepsPerFader?: number;
}

export const DEFAULT_MIN_RAMP_DB = 1;
export const DEFAULT_MAX_STEPS = 16;

export interface RampPlan {
  readonly steps: readonly RampStep[];
  /** Moves sent immediately as a single message. */
  readonly immediate: readonly FaderMove[];
  readonly stepsPerFader: number;
  readonly durationMs: number;
  /** True when the budget forced fewer steps than would be ideal. */
  readonly budgetLimited: boolean;
}

export function planFaderRamp(
  moves: readonly FaderMove[],
  options: RampOptions,
): RampPlan {
  const minRampDb = options.minRampDb ?? DEFAULT_MIN_RAMP_DB;
  const maxSteps = options.maxStepsPerFader ?? DEFAULT_MAX_STEPS;

  const immediate = moves.filter(
    (move) => Math.abs(move.toDb - move.fromDb) < minRampDb,
  );
  const ramped = moves.filter(
    (move) => Math.abs(move.toDb - move.fromDb) >= minRampDb,
  );

  if (ramped.length === 0) {
    return {
      steps: [],
      immediate,
      stepsPerFader: 0,
      durationMs: 0,
      budgetLimited: false,
    };
  }

  // What the wire can carry for the duration of the ramp, minus the messages
  // the immediate moves already spend.
  const budget = Math.floor(
    (options.durationMs / 1000) * options.maxMessagesPerSecond,
  );
  const affordable = Math.floor(
    Math.max(0, budget - immediate.length) / ramped.length,
  );

  // Two steps is the floor: the midpoint and the target. One step is a jump,
  // which is the thing being avoided.
  const stepsPerFader = Math.min(maxSteps, Math.max(2, affordable));
  const budgetLimited = affordable < Math.min(maxSteps, 8);

  const steps: RampStep[] = [];
  const interval = options.durationMs / stepsPerFader;

  for (let step = 1; step <= stepsPerFader; step += 1) {
    const progress = step / stepsPerFader;
    const atMs = Math.round(interval * step);
    for (const move of ramped) {
      const final = step === stepsPerFader;
      steps.push({
        address: move.address,
        // Interpolate where the fader physically is, then report it in dB.
        db: final ? move.toDb : positionLerp(move.fromDb, move.toDb, progress),
        atMs,
        final,
      });
    }
  }

  return {
    steps,
    immediate,
    stepsPerFader,
    durationMs: options.durationMs,
    budgetLimited,
  };
}

/** Interpolates in fader position and returns the dB value at that point. */
export function positionLerp(
  fromDb: number,
  toDb: number,
  progress: number,
): number {
  const from = levelDbToFloat(fromDb);
  const to = levelDbToFloat(toDb);
  const position = from + (to - from) * clamp01(progress);
  return round1(levelFloatToDb(position));
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}
