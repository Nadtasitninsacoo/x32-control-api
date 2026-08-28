/**
 * Minimal OSC 1.0 type model.
 *
 * Only the four argument types the X32/M32 actually uses on the wire are
 * modelled (int32 / float32 / OSC-string / OSC-blob). Everything else is
 * rejected by the codec on purpose: silently accepting a tag we cannot
 * round-trip would corrupt console state.
 */

export type OscArg =
  | { readonly type: 'i'; readonly value: number }
  | { readonly type: 'f'; readonly value: number }
  | { readonly type: 's'; readonly value: string }
  | { readonly type: 'b'; readonly value: Buffer };

export type OscArgType = OscArg['type'];

export interface OscMessage {
  readonly address: string;
  readonly args: readonly OscArg[];
}

export interface OscBundle {
  /** NTP timetag as sent on the wire. `1n` means "immediately". */
  readonly timetag: bigint;
  readonly packets: readonly OscPacket[];
}

export type OscPacket = OscMessage | OscBundle;

export function isBundle(packet: OscPacket): packet is OscBundle {
  return 'packets' in packet;
}

export function isMessage(packet: OscPacket): packet is OscMessage {
  return 'address' in packet;
}

/** Immediate-execution NTP timetag (OSC 1.0 §"Time tags"). */
export const OSC_TIMETAG_IMMEDIATE = 1n;

export const oscInt = (value: number): OscArg => ({ type: 'i', value });
export const oscFloat = (value: number): OscArg => ({ type: 'f', value });
export const oscString = (value: string): OscArg => ({ type: 's', value });
export const oscBlob = (value: Buffer): OscArg => ({ type: 'b', value });

export class OscEncodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OscEncodeError';
  }
}

export class OscDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OscDecodeError';
  }
}

/**
 * Argument accessors. The X32 is loosely typed on replies (a value that is
 * conceptually a boolean arrives as int32, an enum as int32, a level as
 * float32), so callers read through these helpers instead of switching on the
 * tag at every call site.
 */
export function argAsNumber(arg: OscArg | undefined): number | undefined {
  if (arg === undefined) return undefined;
  return arg.type === 'i' || arg.type === 'f' ? arg.value : undefined;
}

export function argAsString(arg: OscArg | undefined): string | undefined {
  return arg?.type === 's' ? arg.value : undefined;
}

export function argAsBlob(arg: OscArg | undefined): Buffer | undefined {
  return arg?.type === 'b' ? arg.value : undefined;
}
