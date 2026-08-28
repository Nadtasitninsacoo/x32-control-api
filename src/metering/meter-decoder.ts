import { OscMessage } from '../osc/codec/osc-types.js';
import { METER_FLOOR_DBFS, meterToDbfs } from '../osc/units/x32-units.js';

/**
 * Meter blobs.
 *
 * The console packs meters as an int32 sample count followed by that many
 * float32 values — and the contents of the blob are **little-endian**, while
 * the OSC framing wrapped around it is big-endian. Reading the blob with the
 * same endianness as the packet is the classic way to get a screen full of
 * nonsense.
 *
 * Samples are linear amplitude in 0..1; the console's own display shows
 * 20·log10 of that, which is what this returns.
 */

export class MeterDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeterDecodeError';
  }
}

/** Decodes one meter blob into dBFS values, in bank order. */
export function decodeMeterBlob(blob: Buffer): number[] {
  if (blob.length < 4) {
    throw new MeterDecodeError(
      `meter blob is ${blob.length} bytes, too short to hold a count`,
    );
  }

  const count = blob.readInt32LE(0);
  if (count < 0 || count > 1024) {
    throw new MeterDecodeError(`implausible meter sample count: ${count}`);
  }

  const expected = 4 + count * 4;
  if (blob.length < expected) {
    throw new MeterDecodeError(
      `meter blob claims ${count} samples (${expected} bytes) but is ${blob.length}`,
    );
  }

  return Array.from({ length: count }, (_, i) =>
    round1(meterToDbfs(blob.readFloatLE(4 + i * 4))),
  );
}

/** Pulls the blob out of a `/meters/N` message, or undefined if it has none. */
export function decodeMeterMessage(message: OscMessage): number[] | undefined {
  const blob = message.args[0];
  if (blob?.type !== 'b') return undefined;
  return decodeMeterBlob(blob.value);
}

/** Meters are read at a glance; a tenth of a dB is as fine as it gets. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

export const SILENCE_DBFS = METER_FLOOR_DBFS;
