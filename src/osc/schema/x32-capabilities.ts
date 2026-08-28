import { STRIP_COUNTS } from '../addresses/x32-addresses.js';

/**
 * What each family of strips actually has.
 *
 * Not every strip carries every processing block: fx returns have no head amp,
 * buses have a six-band EQ where channels have four, DCAs are just a fader and
 * a name. One table decides this for the whole codebase — the emulator seeds
 * from it, the state sync queries from it, and the REST layer exposes from it —
 * so a correction lands in one place instead of three.
 *
 * These assignments follow the X32 feature set as documented; anything the
 * hardware disagrees with is a one-line change here.
 */

export const STRIP_FAMILIES = [
  'ch',
  'auxin',
  'fxrtn',
  'bus',
  'mtx',
  'main',
  'dca',
] as const;

export type StripFamily = (typeof STRIP_FAMILIES)[number];

export interface StripCapabilities {
  /** Name, icon, colour (and input source, on channels and aux inputs). */
  readonly config: boolean;
  /** Fader, mute, pan, stereo/mono assignment. */
  readonly mix: boolean;
  /** Whether the strip carries an input source selector in `config`. */
  readonly source: boolean;
  /** How many sends this strip has (bus sends, or matrix sends on a bus/main). */
  readonly sends: number;
  readonly preamp: boolean;
  readonly gate: boolean;
  readonly dyn: boolean;
  /** EQ bands, 0 when the strip has no EQ. */
  readonly eqBands: number;
}

const CAPABILITIES: Record<StripFamily, StripCapabilities> = {
  ch: {
    config: true,
    mix: true,
    source: true,
    sends: STRIP_COUNTS.bus,
    preamp: true,
    gate: true,
    dyn: true,
    eqBands: 4,
  },
  auxin: {
    config: true,
    mix: true,
    source: true,
    sends: STRIP_COUNTS.bus,
    preamp: true,
    gate: false,
    dyn: false,
    eqBands: 4,
  },
  fxrtn: {
    config: true,
    mix: true,
    source: false,
    sends: STRIP_COUNTS.bus,
    preamp: false,
    gate: false,
    dyn: false,
    eqBands: 4,
  },
  bus: {
    config: true,
    mix: true,
    source: false,
    // Buses feed the matrices.
    sends: STRIP_COUNTS.mtx,
    preamp: false,
    gate: false,
    dyn: true,
    eqBands: 6,
  },
  mtx: {
    config: true,
    mix: true,
    source: false,
    sends: 0,
    preamp: false,
    gate: false,
    dyn: true,
    eqBands: 6,
  },
  main: {
    config: true,
    mix: true,
    source: false,
    sends: STRIP_COUNTS.mtx,
    preamp: false,
    gate: false,
    dyn: true,
    eqBands: 6,
  },
  dca: {
    config: true,
    mix: false,
    source: false,
    sends: 0,
    preamp: false,
    gate: false,
    dyn: false,
    eqBands: 0,
  },
};

export function capabilitiesFor(family: StripFamily): StripCapabilities {
  return CAPABILITIES[family];
}

/** The family a strip root belongs to, e.g. `/main/st` -> `main`. */
export function familyOf(root: string): StripFamily | undefined {
  const match = /^\/(ch|auxin|fxrtn|bus|mtx|dca)\//.exec(root);
  if (match) return match[1] as StripFamily;
  return /^\/main\/(st|m)$/.test(root) ? 'main' : undefined;
}
