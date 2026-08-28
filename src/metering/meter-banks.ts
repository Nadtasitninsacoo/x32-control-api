import { STRIP_COUNTS, pad2 } from '../osc/addresses/x32-addresses.js';

/**
 * Which meter bank to subscribe to, and what its values mean.
 *
 * **Read this before trusting the mapping.** The console publishes each bank as
 * a flat array of numbers with no labels. The bank *addresses* and their sample
 * counts are well established, but exactly which slot carries which strip is
 * documented only unofficially, and is not verified against hardware here.
 *
 * So this file maps only the leading segment of each bank — the part every
 * source agrees on, and the part a surface actually displays — and hands the
 * rest through untouched as `raw`. A frontend gets meters it can trust
 * immediately, and `GET /api/consoles/{id}/meters/raw` exists so the remaining
 * slots can be identified empirically on a real desk: send signal to one input,
 * watch which index moves, and extend `CHANNEL_SEGMENT` here.
 */

export interface MeterBank {
  /** OSC address to subscribe to. */
  readonly address: string;
  /** Sample count the console sends for this bank. */
  readonly count: number;
  readonly description: string;
}

/** Input channel meters. */
export const BANK_CHANNELS: MeterBank = {
  address: '/meters/1',
  count: 96,
  description: 'Input channels, aux inputs and FX returns',
};

/** Main and matrix meters. */
export const BANK_MAINS: MeterBank = {
  address: '/meters/13',
  count: 24,
  description: 'Main stereo, main mono and matrices',
};

export const SUBSCRIBED_BANKS: readonly MeterBank[] = [
  BANK_CHANNELS,
  BANK_MAINS,
];

/**
 * The verified part of `/meters/1`: the first 32 slots are input channels 1-32,
 * in order.
 */
export const CHANNEL_SEGMENT = {
  bank: BANK_CHANNELS,
  offset: 0,
  length: STRIP_COUNTS.ch,
} as const;

/**
 * The verified part of `/meters/13`: main left, main right, main mono.
 */
export const MAIN_SEGMENT = {
  bank: BANK_MAINS,
  offset: 0,
  length: 3,
} as const;

/** Strip ids for the channel segment, so a client can label the array. */
export function channelStripIds(): string[] {
  return Array.from(
    { length: CHANNEL_SEGMENT.length },
    (_, i) => `ch/${pad2(i + 1)}`,
  );
}

export function segmentOf(
  values: readonly number[],
  offset: number,
  length: number,
): number[] {
  return values.slice(offset, offset + length);
}
