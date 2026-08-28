import { describe, expect, it } from 'vitest';
import { message } from '../osc/codec/osc-codec.js';
import { oscBlob, oscFloat } from '../osc/codec/osc-types.js';
import {
  MeterDecodeError,
  decodeMeterBlob,
  decodeMeterMessage,
} from './meter-decoder.js';

/** Builds a meter blob the way the console does: little-endian, inside out. */
function meterBlob(values: number[]): Buffer {
  const buf = Buffer.alloc(4 + values.length * 4);
  buf.writeInt32LE(values.length, 0);
  values.forEach((value, i) => buf.writeFloatLE(value, 4 + i * 4));
  return buf;
}

describe('meter decoding', () => {
  it('reads the little-endian payload inside the big-endian packet', () => {
    // 1.0 linear is 0 dBFS; 0.5 is about -6.
    expect(decodeMeterBlob(meterBlob([1, 0.5, 0.25]))).toEqual([0, -6, -12]);
  });

  it('floors silence rather than returning -Infinity', () => {
    expect(decodeMeterBlob(meterBlob([0]))).toEqual([-90]);
  });

  it('keeps a tenth of a dB, which is as fine as a meter reads', () => {
    const [value] = decodeMeterBlob(meterBlob([0.707]));
    expect(value).toBe(-3);
  });

  it('decodes a full channel bank', () => {
    const values = Array.from({ length: 96 }, (_, i) => (i + 1) / 96);
    const decoded = decodeMeterBlob(meterBlob(values));
    expect(decoded).toHaveLength(96);
    expect(decoded[95]).toBe(0);
    expect(decoded[0]).toBeLessThan(-30);
  });

  it('never reports above full scale', () => {
    expect(decodeMeterBlob(meterBlob([2, 10]))).toEqual([0, 0]);
  });

  describe('malformed blobs', () => {
    it('rejects a blob too short to hold a count', () => {
      expect(() => decodeMeterBlob(Buffer.alloc(2))).toThrow(MeterDecodeError);
    });

    it('rejects a count the blob cannot back up', () => {
      const truncated = meterBlob([1, 1, 1]).subarray(0, 8);
      expect(() => decodeMeterBlob(truncated)).toThrow(/claims 3 samples/);
    });

    it('rejects an implausible count instead of allocating for it', () => {
      const buf = Buffer.alloc(8);
      buf.writeInt32LE(2 ** 20, 0);
      expect(() => decodeMeterBlob(buf)).toThrow(/implausible/);
    });

    it('reads a big-endian blob as garbage rather than as data', () => {
      // The mistake this codebase is built to avoid: the same bytes read with
      // the wrong endianness must not look plausible.
      const buf = Buffer.alloc(8);
      buf.writeInt32BE(1, 0);
      buf.writeFloatBE(0.5, 4);
      expect(() => decodeMeterBlob(buf)).toThrow(MeterDecodeError);
    });
  });

  describe('decodeMeterMessage', () => {
    it('pulls the blob out of a /meters message', () => {
      const msg = message('/meters/1', oscBlob(meterBlob([1])));
      expect(decodeMeterMessage(msg)).toEqual([0]);
    });

    it('returns nothing for a message that carries no blob', () => {
      expect(decodeMeterMessage(message('/meters/1'))).toBeUndefined();
      expect(
        decodeMeterMessage(message('/meters/1', oscFloat(0.5))),
      ).toBeUndefined();
    });
  });
});
