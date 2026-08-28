/**
 * Conversion between human units (dB, Hz, ratio, ms, %) and the raw 0.0–1.0
 * floats the X32/M32 speaks.
 *
 * This file is the ONLY place in the codebase allowed to know about the
 * console's raw numbers. Everything above the OSC layer — services, DTOs,
 * REST, WebSocket, the database — deals in engineering units exclusively.
 *
 * Tapers are taken from the Behringer "X32 OSC Remote Protocol" unofficial
 * specification (Patrick-Gilles Maillot), section "Parameter encoding".
 */

export const MIN_FADER_DB = -90;
export const MAX_FADER_DB = 10;

/** dB value at or below which the console fader is fully closed (-oo). */
export const FADER_OFF_DB = MIN_FADER_DB;

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/** Round to `decimals` places; keeps API output free of float32 noise. */
export function round(value: number, decimals = 1): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/* ------------------------------------------------------------------ *
 * Level (fader / send / main level): 4-segment piecewise linear taper *
 * ------------------------------------------------------------------ */

/**
 * Raw level float -> dB.
 *
 *   0.5000 .. 1.0000  ->  -10 dB .. +10 dB
 *   0.2500 .. 0.4999  ->  -30 dB .. -10 dB
 *   0.0625 .. 0.2499  ->  -60 dB .. -30 dB
 *   0.0000 .. 0.0624  ->  -90 dB .. -60 dB   (0.0 == -oo)
 */
export function levelFloatToDb(value: number): number {
  const f = clamp(value, 0, 1);
  if (f >= 0.5) return f * 40 - 30;
  if (f >= 0.25) return f * 80 - 50;
  if (f >= 0.0625) return f * 160 - 70;
  if (f > 0) return f * 480 - 90;
  return MIN_FADER_DB;
}

/** dB -> raw level float (inverse of {@link levelFloatToDb}). */
export function levelDbToFloat(db: number): number {
  const d = clamp(db, MIN_FADER_DB, MAX_FADER_DB);
  if (d <= MIN_FADER_DB) return 0;
  if (d >= -10) return (d + 30) / 40;
  if (d >= -30) return (d + 50) / 80;
  if (d >= -60) return (d + 70) / 160;
  return (d + 90) / 480;
}

/* ------------------------------------- *
 * Generic linear and logarithmic tapers *
 * ------------------------------------- */

export interface LinearTaper {
  readonly min: number;
  readonly max: number;
}

export function linearToUnit(taper: LinearTaper, value: number): number {
  return clamp((value - taper.min) / (taper.max - taper.min), 0, 1);
}

export function linearFromUnit(taper: LinearTaper, value: number): number {
  return taper.min + clamp(value, 0, 1) * (taper.max - taper.min);
}

/** Logarithmic taper; `min` and `max` must both be > 0 (max may be < min). */
export function logToUnit(taper: LinearTaper, value: number): number {
  const v = clamp(
    value,
    Math.min(taper.min, taper.max),
    Math.max(taper.min, taper.max),
  );
  return clamp(Math.log(v / taper.min) / Math.log(taper.max / taper.min), 0, 1);
}

export function logFromUnit(taper: LinearTaper, value: number): number {
  return taper.min * (taper.max / taper.min) ** clamp(value, 0, 1);
}

/* ------------------------------------------------- *
 * Named parameter tapers, as used by the X32 console *
 * ------------------------------------------------- */

export const TAPERS = {
  /** Head amp gain, -12 .. +60 dB in 0.5 dB steps. */
  headampGain: { min: -12, max: 60 } as LinearTaper,
  /** Pan, hard left .. hard right, exposed as -100 .. +100. */
  pan: { min: -100, max: 100 } as LinearTaper,
  /** EQ band gain, -15 .. +15 dB. */
  eqGain: { min: -15, max: 15 } as LinearTaper,
  /** EQ band frequency, 20 Hz .. 20 kHz, logarithmic. */
  eqFreq: { min: 20, max: 20000 } as LinearTaper,
  /** EQ band Q, 10 .. 0.3 — note the console's slider runs *downwards*. */
  eqQ: { min: 10, max: 0.3 } as LinearTaper,
  /** Low-cut filter frequency, 20 .. 400 Hz, logarithmic. */
  lowCutFreq: { min: 20, max: 400 } as LinearTaper,
  /** Compressor threshold, -60 .. 0 dB. */
  compThreshold: { min: -60, max: 0 } as LinearTaper,
  /** Gate threshold, -80 .. 0 dB. */
  gateThreshold: { min: -80, max: 0 } as LinearTaper,
  /** Gate range (depth of attenuation), 3 .. 60 dB. */
  gateRange: { min: 3, max: 60 } as LinearTaper,
  /** Dynamics make-up gain, 0 .. 24 dB. */
  compMakeupGain: { min: 0, max: 24 } as LinearTaper,
  /** Dynamics knee, 0 .. 5. */
  compKnee: { min: 0, max: 5 } as LinearTaper,
  /** Dynamics mix, 0 .. 100 %. */
  compMix: { min: 0, max: 100 } as LinearTaper,
  /** Attack time, 0 .. 120 ms (linear on this console). */
  attackMs: { min: 0, max: 120 } as LinearTaper,
  /** Hold time, 0.02 .. 2000 ms, logarithmic. */
  holdMs: { min: 0.02, max: 2000 } as LinearTaper,
  /** Release time, 5 .. 4000 ms, logarithmic. */
  releaseMs: { min: 5, max: 4000 } as LinearTaper,
} as const;

export const headampGainToFloat = (db: number): number =>
  linearToUnit(TAPERS.headampGain, db);
export const headampGainFromFloat = (f: number): number =>
  linearFromUnit(TAPERS.headampGain, f);

export const panToFloat = (pan: number): number =>
  linearToUnit(TAPERS.pan, pan);
export const panFromFloat = (f: number): number =>
  linearFromUnit(TAPERS.pan, f);

export const eqGainToFloat = (db: number): number =>
  linearToUnit(TAPERS.eqGain, db);
export const eqGainFromFloat = (f: number): number =>
  linearFromUnit(TAPERS.eqGain, f);

export const eqFreqToFloat = (hz: number): number =>
  logToUnit(TAPERS.eqFreq, hz);
export const eqFreqFromFloat = (f: number): number =>
  logFromUnit(TAPERS.eqFreq, f);

export const eqQToFloat = (q: number): number => logToUnit(TAPERS.eqQ, q);
export const eqQFromFloat = (f: number): number => logFromUnit(TAPERS.eqQ, f);

export const lowCutFreqToFloat = (hz: number): number =>
  logToUnit(TAPERS.lowCutFreq, hz);
export const lowCutFreqFromFloat = (f: number): number =>
  logFromUnit(TAPERS.lowCutFreq, f);

export const attackMsToFloat = (ms: number): number =>
  linearToUnit(TAPERS.attackMs, ms);
export const attackMsFromFloat = (f: number): number =>
  linearFromUnit(TAPERS.attackMs, f);

export const holdMsToFloat = (ms: number): number =>
  logToUnit(TAPERS.holdMs, ms);
export const holdMsFromFloat = (f: number): number =>
  logFromUnit(TAPERS.holdMs, f);

export const releaseMsToFloat = (ms: number): number =>
  logToUnit(TAPERS.releaseMs, ms);
export const releaseMsFromFloat = (f: number): number =>
  logFromUnit(TAPERS.releaseMs, f);

/* -------------------------------- *
 * Enumerated (int32) parameters    *
 * -------------------------------- */

/** Compressor / expander ratios, in console index order. */
export const COMP_RATIOS = [
  1.1, 1.3, 1.5, 2, 2.5, 3, 4, 5, 7, 10, 20, 100,
] as const;

export function compRatioToIndex(ratio: number): number {
  let best = 0;
  let bestDelta = Infinity;
  COMP_RATIOS.forEach((candidate, index) => {
    const delta = Math.abs(candidate - ratio);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = index;
    }
  });
  return best;
}

export function compRatioFromIndex(index: number): number {
  return COMP_RATIOS[clamp(Math.round(index), 0, COMP_RATIOS.length - 1)];
}

/** Channel strip colours, in console index order (…/config/color). */
export const CHANNEL_COLORS = [
  'OFF',
  'RD',
  'GN',
  'YE',
  'BL',
  'MG',
  'CY',
  'WH',
  'OFFi',
  'RDi',
  'GNi',
  'YEi',
  'BLi',
  'MGi',
  'CYi',
  'WHi',
] as const;

export type ChannelColor = (typeof CHANNEL_COLORS)[number];

export function colorToIndex(color: ChannelColor): number {
  const index = CHANNEL_COLORS.indexOf(color);
  return index === -1 ? 0 : index;
}

export function colorFromIndex(index: number): ChannelColor {
  return CHANNEL_COLORS[clamp(Math.round(index), 0, CHANNEL_COLORS.length - 1)];
}

/* --------- *
 * Metering  *
 * --------- */

/** Floor reported for a silent meter; below this the log blows up. */
export const METER_FLOOR_DBFS = -90;

/**
 * Meter blob samples are linear amplitude in 0..1; the console's own display
 * shows 20·log10 of that value.
 */
export function meterToDbfs(value: number): number {
  if (value <= 0) return METER_FLOOR_DBFS;
  return clamp(20 * Math.log10(value), METER_FLOOR_DBFS, 0);
}

export function dbfsToMeter(dbfs: number): number {
  if (dbfs <= METER_FLOOR_DBFS) return 0;
  return clamp(10 ** (clamp(dbfs, METER_FLOOR_DBFS, 0) / 20), 0, 1);
}

/* ---------------------- *
 * Booleans (ON/OFF ints) *
 * ---------------------- */

export const boolToInt = (on: boolean): number => (on ? 1 : 0);
export const boolFromInt = (value: number): boolean => value >= 1;

/**
 * Mute is inverted on the X32: `/ch/../mix/on` is 1 when the channel is
 * *unmuted*. Getting this backwards silences a show, so it lives here with a
 * name that cannot be misread.
 */
export const mutedToOnInt = (muted: boolean): number => (muted ? 0 : 1);
export const mutedFromOnInt = (on: number): boolean => on < 1;
