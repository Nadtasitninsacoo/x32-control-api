import { MeasurementPoint } from '../measurement/measurement-parser.js';

/**
 * Turning a room measurement into a handful of PEQ bands.
 *
 * The rules here are the ones that separate useful room EQ from the kind that
 * makes a system sound worse:
 *
 *  - **Smooth first.** A raw sweep is full of narrow nulls caused by
 *    cancellation at the mic position. They move when you move, and filling
 *    them costs headroom for a listener who is not standing where the mic was.
 *    1/6 octave smoothing keeps what the room does everywhere and discards what
 *    it does in one spot.
 *  - **Cut freely, boost sparingly.** A cut costs nothing; a boost spends
 *    headroom and amplifier power on the resonance that is already loudest.
 *    Boosts are capped (+6 dB by default), cuts are not.
 *  - **Stay in the range EQ can fix.** Below ~40 Hz the problem is the room and
 *    the subs, above ~8 kHz it is air and directivity. Filters outside that
 *    range spend bands on things they cannot change.
 *  - **Spend the bands where they buy the most.** Fitting is greedy: the worst
 *    remaining deviation gets the next band, and fitting stops early when what
 *    is left is inaudible, rather than using up bands for the sake of it.
 */

export interface PeqBand {
  /** 1-based, in the order they should be written to the console. */
  readonly band: number;
  readonly frequencyHz: number;
  readonly gainDb: number;
  readonly q: number;
}

export interface FitOptions {
  /** How many bands the destination strip has. */
  readonly bands: number;
  /** Correction range. Outside it, EQ cannot fix what is wrong. */
  readonly minHz?: number;
  readonly maxHz?: number;
  /** Fraction of an octave to smooth by: 6 means 1/6 octave. */
  readonly smoothingOctaveFraction?: number;
  /** Never boost more than this. */
  readonly maxBoostDb?: number;
  /** Cuts are cheap, but the console still has a limit. */
  readonly maxCutDb?: number;
  /** Stop fitting when nothing is left above this deviation. */
  readonly toleranceDb?: number;
  /** House curve tilt in dB per octave, referenced at 1 kHz. Negative = darker. */
  readonly tiltDbPerOctave?: number;
  readonly minQ?: number;
  readonly maxQ?: number;
}

export interface FitResult {
  readonly bands: readonly PeqBand[];
  /** Log-spaced analysis grid, in Hz. */
  readonly frequencies: readonly number[];
  /** Smoothed measurement on that grid, normalised to the in-band average. */
  readonly before: readonly number[];
  /** What the same measurement becomes with the filters applied. */
  readonly after: readonly number[];
  /** The curve being aimed at. */
  readonly target: readonly number[];
  /** Standard deviation from target inside the correction range, before. */
  readonly deviationBeforeDb: number;
  readonly deviationAfterDb: number;
}

export const DEFAULTS = {
  minHz: 40,
  maxHz: 8000,
  smoothingOctaveFraction: 6,
  maxBoostDb: 6,
  maxCutDb: 12,
  toleranceDb: 1,
  tiltDbPerOctave: 0,
  minQ: 0.5,
  maxQ: 8,
  gridPoints: 240,
} as const;

/** Magnitude response of one peaking filter, in dB, at a given frequency. */
export function peakingResponseDb(
  hz: number,
  centreHz: number,
  gainDb: number,
  q: number,
): number {
  if (gainDb === 0) return 0;
  const a = 10 ** (gainDb / 40);
  const w = hz / centreHz;
  const w2 = 1 - w * w;
  const numerator = Math.sqrt(w2 * w2 + ((a * w) / q) ** 2);
  const denominator = Math.sqrt(w2 * w2 + (w / (a * q)) ** 2);
  return 20 * Math.log10(numerator / denominator);
}

/** Combined response of a filter set. */
export function responseOf(
  bands: readonly PeqBand[],
  frequencies: readonly number[],
): number[] {
  return frequencies.map((hz) =>
    bands.reduce(
      (sum, band) =>
        sum + peakingResponseDb(hz, band.frequencyHz, band.gainDb, band.q),
      0,
    ),
  );
}

/** Log-spaced frequency grid — the axis a response is actually read on. */
export function logGrid(
  fromHz: number,
  toHz: number,
  points: number,
): number[] {
  const ratio = Math.log(toHz / fromHz) / (points - 1);
  return Array.from({ length: points }, (_, i) => fromHz * Math.exp(ratio * i));
}

/**
 * 1/N octave smoothing: each output point is the average of every measurement
 * inside a band centred on it.
 */
export function smooth(
  points: readonly MeasurementPoint[],
  frequencies: readonly number[],
  octaveFraction: number,
): number[] {
  const halfWidth = 2 ** (1 / (2 * octaveFraction));

  return frequencies.map((centre) => {
    const low = centre / halfWidth;
    const high = centre * halfWidth;

    let sum = 0;
    let count = 0;
    for (const point of points) {
      if (point.hz < low) continue;
      if (point.hz > high) break;
      sum += point.db;
      count += 1;
    }
    // A gap in the data (sparse exports at low frequencies) falls back to the
    // nearest measured point rather than inventing a value.
    return count > 0 ? sum / count : nearest(points, centre);
  });
}

function nearest(points: readonly MeasurementPoint[], hz: number): number {
  let best = points[0];
  let bestDistance = Infinity;
  for (const point of points) {
    const distance = Math.abs(Math.log(point.hz / hz));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = point;
    }
  }
  return best.db;
}

export function fitPeq(
  points: readonly MeasurementPoint[],
  options: FitOptions,
): FitResult {
  const minHz = options.minHz ?? DEFAULTS.minHz;
  const maxHz = options.maxHz ?? DEFAULTS.maxHz;
  const maxBoost = options.maxBoostDb ?? DEFAULTS.maxBoostDb;
  const maxCut = options.maxCutDb ?? DEFAULTS.maxCutDb;
  const tolerance = options.toleranceDb ?? DEFAULTS.toleranceDb;
  const minQ = options.minQ ?? DEFAULTS.minQ;
  const maxQ = options.maxQ ?? DEFAULTS.maxQ;

  // The grid runs wider than the correction range so the graph shows what the
  // filters do to the edges, where they are not allowed to place bands.
  const frequencies = logGrid(
    Math.max(20, Math.min(minHz / 2, points[0].hz)),
    Math.min(20000, Math.max(maxHz * 2, points[points.length - 1].hz)),
    DEFAULTS.gridPoints,
  );

  const smoothed = smooth(
    points,
    frequencies,
    options.smoothingOctaveFraction ?? DEFAULTS.smoothingOctaveFraction,
  );
  const inBand = frequencies.map((hz) => hz >= minHz && hz <= maxHz);

  // Normalise to the in-band average: absolute SPL is irrelevant, the shape is
  // the whole point, and this keeps the filters from all pulling one way.
  const average = mean(smoothed.filter((_, i) => inBand[i]));
  const before = smoothed.map((db) => db - average);

  const tilt = options.tiltDbPerOctave ?? DEFAULTS.tiltDbPerOctave;
  const target = frequencies.map((hz) =>
    tilt === 0 ? 0 : Math.log2(hz / 1000) * tilt,
  );
  const targetAverage = mean(target.filter((_, i) => inBand[i]));
  const normalisedTarget = target.map((db) => db - targetAverage);

  const error = before.map((db, i) => db - normalisedTarget[i]);
  const bands: PeqBand[] = [];

  for (let n = 0; n < options.bands; n += 1) {
    const peak = worstDeviation(error, frequencies, inBand);
    if (!peak || Math.abs(peak.value) < tolerance) break;

    const gain = clamp(-peak.value, -maxCut, maxBoost);
    if (Math.abs(gain) < 0.1) break;

    const q = clamp(estimateQ(error, frequencies, peak.index), minQ, maxQ);
    const band: PeqBand = {
      band: bands.length + 1,
      frequencyHz: round(frequencies[peak.index], 1),
      gainDb: round(gain, 1),
      q: round(q, 2),
    };
    bands.push(band);

    // Subtract what this filter will do, so the next band sees what is left.
    for (let i = 0; i < error.length; i += 1) {
      error[i] += peakingResponseDb(
        frequencies[i],
        band.frequencyHz,
        band.gainDb,
        band.q,
      );
    }
  }

  const applied = responseOf(bands, frequencies);
  const after = before.map((db, i) => db + applied[i]);

  return {
    bands,
    frequencies: frequencies.map((hz) => round(hz, 1)),
    before: before.map((db) => round(db, 2)),
    after: after.map((db) => round(db, 2)),
    target: normalisedTarget.map((db) => round(db, 2)),
    deviationBeforeDb: round(deviation(before, normalisedTarget, inBand), 2),
    deviationAfterDb: round(deviation(after, normalisedTarget, inBand), 2),
  };
}

function worstDeviation(
  error: readonly number[],
  frequencies: readonly number[],
  inBand: readonly boolean[],
): { index: number; value: number } | undefined {
  let index = -1;
  let value = 0;
  for (let i = 0; i < error.length; i += 1) {
    if (!inBand[i]) continue;
    if (Math.abs(error[i]) > Math.abs(value)) {
      value = error[i];
      index = i;
    }
  }
  return index === -1 ? undefined : { index, value };
}

/**
 * Q from the width of the deviation: the filter should be as wide as the
 * problem, no wider. Measured where the error falls to half the peak.
 */
function estimateQ(
  error: readonly number[],
  frequencies: readonly number[],
  peakIndex: number,
): number {
  const peak = error[peakIndex];
  const half = Math.abs(peak) / 2;
  const sign = Math.sign(peak);

  let low = peakIndex;
  while (low > 0 && sign * error[low] > half) low -= 1;

  let high = peakIndex;
  while (high < error.length - 1 && sign * error[high] > half) high += 1;

  const bandwidth = frequencies[high] - frequencies[low];
  if (bandwidth <= 0) return DEFAULTS.maxQ;
  return frequencies[peakIndex] / bandwidth;
}

function deviation(
  curve: readonly number[],
  target: readonly number[],
  inBand: readonly boolean[],
): number {
  const errors = curve
    .map((db, i) => db - target[i])
    .filter((_, i) => inBand[i]);
  if (errors.length === 0) return 0;
  const average = mean(errors);
  return Math.sqrt(mean(errors.map((error) => (error - average) ** 2)));
}

function mean(values: readonly number[]): number {
  return values.length === 0
    ? 0
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}
