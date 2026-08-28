import { describe, expect, it } from 'vitest';
import {
  assertOutboundAddress,
  bundle,
  decodeMessages,
  decodePacket,
  encodeBundle,
  encodeMessage,
  formatMessage,
  message,
} from './osc-codec.js';
import {
  OscDecodeError,
  OscEncodeError,
  argAsNumber,
  isBundle,
  isMessage,
  oscBlob,
  oscFloat,
  oscInt,
  oscString,
} from './osc-types.js';

describe('OscCodec', () => {
  describe('encoding: byte layout', () => {
    it('pads an argument-less message to 4-byte boundaries', () => {
      // "/x" + NUL -> 3 bytes -> padded to 4; "," + NUL -> 2 -> padded to 4.
      const buf = encodeMessage(message('/x'));
      expect([...buf]).toEqual([
        0x2f, 0x78, 0x00, 0x00, 0x2c, 0x00, 0x00, 0x00,
      ]);
    });

    it('adds a full extra pad word when the string already fills a word', () => {
      // "/abc" is 4 bytes, so the mandatory NUL forces a whole extra word.
      const buf = encodeMessage(message('/abc'));
      expect(buf.length).toBe(8 + 4);
      expect(buf.subarray(0, 8).toString('binary')).toBe('/abc\0\0\0\0');
    });

    it('writes int32 big-endian', () => {
      const buf = encodeMessage(message('/i', oscInt(1)));
      expect([...buf.subarray(-4)]).toEqual([0x00, 0x00, 0x00, 0x01]);
    });

    it('writes float32 big-endian', () => {
      const buf = encodeMessage(message('/f', oscFloat(440)));
      // 440.0f == 0x43DC0000
      expect([...buf.subarray(-4)]).toEqual([0x43, 0xdc, 0x00, 0x00]);
    });

    it('writes a blob as int32 size followed by NUL-padded bytes', () => {
      const buf = encodeMessage(
        message('/b', oscBlob(Buffer.from([1, 2, 3, 4, 5]))),
      );
      const payload = buf.subarray(8);
      expect(payload.readInt32BE(0)).toBe(5);
      expect([...payload.subarray(4)]).toEqual([1, 2, 3, 4, 5, 0, 0, 0]);
    });

    it('emits a type tag string for every argument, in order', () => {
      const buf = encodeMessage(
        message(
          '/mix',
          oscInt(1),
          oscFloat(0.5),
          oscString('ON'),
          oscBlob(Buffer.alloc(0)),
        ),
      );
      expect(buf.subarray(8, 16).toString('binary')).toBe(',ifsb\0\0\0');
    });

    it('always produces a packet length that is a multiple of 4', () => {
      for (const address of ['/a', '/ab', '/abc', '/abcd', '/abcde']) {
        expect(
          encodeMessage(message(address, oscString('xy'))).length % 4,
        ).toBe(0);
      }
    });
  });

  describe('round trips', () => {
    it('preserves all four argument types', () => {
      const original = message(
        '/ch/01/mix',
        oscInt(-7),
        oscFloat(0.25),
        oscString('Kick In'),
        oscBlob(Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x01])),
      );
      const decoded = decodePacket(encodeMessage(original));
      expect(decoded).toEqual(original);
    });

    it('preserves an empty string and an empty blob', () => {
      const original = message('/e', oscString(''), oscBlob(Buffer.alloc(0)));
      expect(decodePacket(encodeMessage(original))).toEqual(original);
    });

    it('preserves UTF-8 names', () => {
      const original = message('/ch/01/config/name', oscString('กลอง'));
      expect(decodePacket(encodeMessage(original))).toEqual(original);
    });

    it('keeps float32 precision within a float32 step', () => {
      const decoded = decodePacket(encodeMessage(message('/f', oscFloat(0.6))));
      expect(isMessage(decoded)).toBe(true);
      if (!isMessage(decoded)) return;
      expect(argAsNumber(decoded.args[0])).toBeCloseTo(0.6, 6);
    });

    it('round-trips a bundle of messages', () => {
      const original = bundle([
        message('/a', oscInt(1)),
        message('/b', oscFloat(2)),
      ]);
      const decoded = decodePacket(encodeBundle(original));
      expect(isBundle(decoded)).toBe(true);
      expect(decoded).toEqual(original);
    });

    it('flattens nested bundles into a message list', () => {
      const nested = bundle([
        bundle([message('/deep', oscInt(9))]),
        message('/flat'),
      ]);
      expect(
        decodeMessages(encodeBundle(nested)).map((m) => m.address),
      ).toEqual(['/deep', '/flat']);
    });
  });

  describe('X32 quirks', () => {
    it('decodes a reply whose address has no leading slash (/node answers on "node")', () => {
      const raw = encodeMessage({
        address: 'node',
        args: [oscString('/ch/01/mix ON -6.0 ON +0 OFF -oo')],
      });
      expect(decodePacket(raw)).toEqual({
        address: 'node',
        args: [{ type: 's', value: '/ch/01/mix ON -6.0 ON +0 OFF -oo' }],
      });
    });

    it('decodes a query, which the console sends with no type tag string at all', () => {
      // "/q" + NUL + pad, and nothing else.
      const raw = Buffer.from([0x2f, 0x71, 0x00, 0x00]);
      expect(decodePacket(raw)).toEqual({ address: '/q', args: [] });
    });

    it('rejects an address without a leading slash on the way out', () => {
      expect(() => assertOutboundAddress('node')).toThrow(OscEncodeError);
      expect(() => assertOutboundAddress('/ch/01/mix/fader')).not.toThrow();
    });
  });

  describe('malformed input', () => {
    it('rejects a packet whose length is not a multiple of 4', () => {
      expect(() => decodePacket(Buffer.from([0x2f, 0x61, 0x00]))).toThrow(
        OscDecodeError,
      );
    });

    it('rejects an unterminated address string', () => {
      expect(() => decodePacket(Buffer.from([0x2f, 0x61, 0x62, 0x63]))).toThrow(
        OscDecodeError,
      );
    });

    it('rejects a type tag string that does not start with a comma', () => {
      const raw = Buffer.concat([
        Buffer.from('/a\0\0', 'binary'),
        Buffer.from('if\0\0', 'binary'),
        Buffer.alloc(8),
      ]);
      expect(() => decodePacket(raw)).toThrow(/must start with ","/);
    });

    it('rejects an unsupported type tag rather than guessing', () => {
      const raw = Buffer.concat([
        Buffer.from('/a\0\0', 'binary'),
        Buffer.from(',T\0\0', 'binary'),
      ]);
      expect(() => decodePacket(raw)).toThrow(/unsupported OSC type tag/);
    });

    it('rejects a truncated argument', () => {
      const raw = Buffer.concat([
        Buffer.from('/a\0\0', 'binary'),
        Buffer.from(',i\0\0', 'binary'),
      ]);
      expect(() => decodePacket(raw)).toThrow(/truncated packet/);
    });

    it('rejects a blob that claims more bytes than the packet holds', () => {
      const raw = Buffer.concat([
        Buffer.from('/b\0\0', 'binary'),
        Buffer.from(',b\0\0', 'binary'),
        (() => {
          const size = Buffer.alloc(4);
          size.writeInt32BE(64, 0);
          return size;
        })(),
      ]);
      expect(() => decodePacket(raw)).toThrow(/truncated packet/);
    });

    it('rejects non-integer and out-of-range int32 arguments', () => {
      expect(() => encodeMessage(message('/i', oscInt(1.5)))).toThrow(
        OscEncodeError,
      );
      expect(() => encodeMessage(message('/i', oscInt(2 ** 31)))).toThrow(
        OscEncodeError,
      );
    });

    it('rejects a non-finite float32 argument', () => {
      expect(() => encodeMessage(message('/f', oscFloat(Number.NaN)))).toThrow(
        OscEncodeError,
      );
    });

    it('rejects a string argument containing a NUL', () => {
      expect(() => encodeMessage(message('/s', oscString('a\0b')))).toThrow(
        OscEncodeError,
      );
    });
  });

  describe('formatMessage', () => {
    it('renders addresses, tags and values for the audit log', () => {
      expect(formatMessage(message('/ch/01/mix/fader', oscFloat(0.6)))).toBe(
        '/ch/01/mix/fader ,f 0.6',
      );
      expect(formatMessage(message('/xremote'))).toBe('/xremote');
      expect(
        formatMessage(message('/meters/1', oscBlob(Buffer.alloc(8)))),
      ).toBe('/meters/1 ,b <blob 8B>');
    });
  });
});
