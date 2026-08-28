import { BadRequestException } from '@nestjs/common';
import { STRIP_COUNTS, pad2 } from '../osc/addresses/x32-addresses.js';
import {
  StripCapabilities,
  StripFamily,
  capabilitiesFor,
} from '../osc/schema/x32-capabilities.js';

/**
 * Translates the REST identity of a strip (`ch/1`, `main/st`, `dca/3`) into
 * its OSC root, rejecting anything the console does not have.
 *
 * The API accepts `ch/1` and `ch/01` alike — a frontend should not have to
 * know that the console zero-pads — and `main/lr` as an alias for `main/st`,
 * because that is what the surface is labelled.
 */

export interface StripRef {
  readonly family: StripFamily;
  /** Canonical index as it appears in the id: `01`, `st`, `3`. */
  readonly index: string;
  /** `/ch/01`, `/main/st`, `/dca/3`. */
  readonly root: string;
  /** Stable id used in URLs and payloads: `ch/01`. */
  readonly id: string;
  readonly capabilities: StripCapabilities;
}

const MAIN_ALIASES: Record<string, string> = {
  st: 'st',
  lr: 'st',
  stereo: 'st',
  m: 'm',
  mono: 'm',
};

const NUMBERED: Record<string, number> = {
  ch: STRIP_COUNTS.ch,
  auxin: STRIP_COUNTS.auxin,
  fxrtn: STRIP_COUNTS.fxrtn,
  bus: STRIP_COUNTS.bus,
  mtx: STRIP_COUNTS.mtx,
  dca: STRIP_COUNTS.dca,
};

export function resolveStrip(kind: string, index: string): StripRef {
  const family = kind.toLowerCase();

  if (family === 'main') {
    const which = MAIN_ALIASES[index.toLowerCase()];
    if (!which) {
      throw new BadRequestException(
        `main strip must be "st" (or "lr") or "m" (or "mono")`,
      );
    }
    return {
      family: 'main',
      index: which,
      root: `/main/${which}`,
      id: `main/${which}`,
      capabilities: capabilitiesFor('main'),
    };
  }

  const count = NUMBERED[family];
  if (count === undefined) {
    throw new BadRequestException(
      `unknown strip kind "${kind}" — expected one of ch, auxin, fxrtn, bus, mtx, main, dca`,
    );
  }

  const number = Number(index);
  if (!Number.isInteger(number) || number < 1 || number > count) {
    throw new BadRequestException(
      `${family} index must be between 1 and ${count}, got "${index}"`,
    );
  }

  // DCAs are single-digit on the wire; everything else is zero-padded.
  const canonical = family === 'dca' ? String(number) : pad2(number);
  return {
    family: family as StripFamily,
    index: canonical,
    root: `/${family}/${canonical}`,
    id: `${family}/${canonical}`,
    capabilities: capabilitiesFor(family as StripFamily),
  };
}

/** Every strip the console has, in surface order. */
export function allStrips(): StripRef[] {
  const refs: StripRef[] = [];
  for (const family of ['ch', 'auxin', 'fxrtn', 'bus', 'mtx'] as const) {
    for (let i = 1; i <= NUMBERED[family]; i += 1)
      refs.push(resolveStrip(family, String(i)));
  }
  refs.push(resolveStrip('main', 'st'), resolveStrip('main', 'm'));
  for (let i = 1; i <= NUMBERED.dca; i += 1)
    refs.push(resolveStrip('dca', String(i)));
  return refs;
}

/**
 * The head amp feeding a channel. Head amps are addressed globally rather than
 * per strip, and only the 32 local XLR inputs are covered here.
 */
export function headampIndexFor(ref: StripRef): number | undefined {
  return ref.family === 'ch' ? Number(ref.index) : undefined;
}
