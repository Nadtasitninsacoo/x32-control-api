/**
 * The console's address space: how many of each strip exist and how their OSC
 * roots are spelled. Kept in the OSC layer because it is wire knowledge, not
 * mixer semantics.
 */

export const STRIP_COUNTS = {
  ch: 32,
  auxin: 8,
  fxrtn: 8,
  bus: 16,
  mtx: 6,
  dca: 8,
} as const;

export type NumberedStripKind = keyof typeof STRIP_COUNTS;
export type MainKind = 'main/st' | 'main/m';
export type StripKind = NumberedStripKind | MainKind;

export const pad2 = (index: number): string => String(index).padStart(2, '0');

/**
 * Root address of a strip. Channels, aux, fx returns, buses and matrices use
 * two-digit indices; DCAs use one digit; the mains have no index at all.
 */
export function stripRoot(kind: StripKind, index = 1): string {
  if (kind === 'main/st' || kind === 'main/m') return `/${kind}`;
  if (kind === 'dca') return `/dca/${index}`;
  return `/${kind}/${pad2(index)}`;
}

export function stripRoots(kind: NumberedStripKind): string[] {
  return Array.from({ length: STRIP_COUNTS[kind] }, (_, i) =>
    stripRoot(kind, i + 1),
  );
}

/** Every strip root the console exposes, in console order. */
export function allStripRoots(): string[] {
  return [
    ...stripRoots('ch'),
    ...stripRoots('auxin'),
    ...stripRoots('fxrtn'),
    ...stripRoots('bus'),
    ...stripRoots('mtx'),
    '/main/st',
    '/main/m',
    ...stripRoots('dca'),
  ];
}

/** Bus send address on a source strip, e.g. `/ch/01/mix/03/level`. */
export function busSendLevelAddress(
  sourceRoot: string,
  busIndex: number,
): string {
  return `${sourceRoot}/mix/${pad2(busIndex)}/level`;
}

/**
 * Head amp addresses are global, not per-strip: local XLR inputs 1-32 are
 * `/headamp/000`..`/headamp/031`.
 */
export function headampRoot(inputIndex: number): string {
  return `/headamp/${String(inputIndex - 1).padStart(3, '0')}`;
}
