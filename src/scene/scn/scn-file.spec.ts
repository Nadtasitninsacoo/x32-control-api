import { describe, expect, it } from 'vitest';
import {
  OscArg,
  oscFloat,
  oscInt,
  oscString,
} from '../../osc/codec/osc-types.js';
import { paramFor, toHuman } from '../../osc/schema/x32-schema.js';
import { levelDbToFloat } from '../../osc/units/x32-units.js';
import {
  ScnParseError,
  parseScnFile,
  serializeContainer,
  serializeScnFile,
} from './scn-file.js';

/** A small but realistic scene file, in the console's own shape. */
const SAMPLE = [
  '#2.7# "Rock Night" "FOH base" %000000000 1',
  '/ch/01/config "Kick In" 1 GN 1',
  '/ch/01/mix ON   -6.0 ON +0 OFF   -oo',
  '/ch/01/eq/1 PEQ 100.0 -3.0 2.00',
  '/ch/02/config "Snare" 1 RD 2',
  '/ch/02/mix OFF   -10.0 ON -20 OFF   -oo',
  '/config/routing/IN AN1-8 AN9-16 AN17-24 AN25-32 A1-8',
  '/fx/1/type DLY',
].join('\n');

function human(
  values: ReadonlyMap<string, OscArg[]>,
  address: string,
): unknown {
  const args = values.get(address);
  const def = paramFor(address);
  return args && def ? toHuman(def, args[0]) : undefined;
}

describe('.scn scene files', () => {
  describe('parsing', () => {
    it('reads the header', () => {
      const file = parseScnFile(SAMPLE);
      expect(file.header).toEqual({
        version: '2.7',
        name: 'Rock Night',
        note: 'FOH base',
        flags: '%000000000',
        kind: 1,
      });
    });

    it('decodes the strips it understands', () => {
      const file = parseScnFile(SAMPLE);
      expect(human(file.values, '/ch/01/config/name')).toBe('Kick In');
      expect(human(file.values, '/ch/01/mix/fader')).toBe(-6);
      expect(human(file.values, '/ch/01/mix/on')).toBe(true);
      expect(human(file.values, '/ch/02/mix/on')).toBe(false);
      expect(human(file.values, '/ch/02/mix/pan')).toBe(-20);
      expect(human(file.values, '/ch/01/eq/1/gainDb')).toBeUndefined();
      expect(human(file.values, '/ch/01/eq/1/g')).toBe(-3);
    });

    it('keeps lines it has no schema for instead of discarding them', () => {
      const file = parseScnFile(SAMPLE);
      expect(file.unknownLines).toEqual([
        '/config/routing/IN AN1-8 AN9-16 AN17-24 AN25-32 A1-8',
        '/fx/1/type DLY',
      ]);
      expect(file.rejectedLines).toEqual([]);
    });

    it('reports a line whose value count disagrees with the schema', () => {
      const file = parseScnFile(
        [
          '#2.7# "x" "" %000000000 1',
          '/ch/01/mix ON -6.0 ON +0 OFF -oo EXTRA',
        ].join('\n'),
      );
      expect(file.rejectedLines).toHaveLength(1);
      expect(file.values.size).toBe(0);
    });

    it('refuses a file that is not a scene file', () => {
      expect(() => parseScnFile('hello')).toThrow(ScnParseError);
      expect(() => parseScnFile('')).toThrow(ScnParseError);
      expect(() => parseScnFile('{"json": true}')).toThrow(
        /not an X32 scene file/,
      );
    });

    it('tolerates CRLF and blank lines', () => {
      const file = parseScnFile(SAMPLE.replace(/\n/g, '\r\n') + '\r\n\r\n');
      expect(human(file.values, '/ch/01/mix/fader')).toBe(-6);
    });
  });

  describe('serialising', () => {
    const state = new Map<string, OscArg[]>([
      ['/ch/01/config/name', [oscString('Kick In')]],
      ['/ch/01/config/icon', [oscInt(1)]],
      ['/ch/01/config/color', [oscInt(2)]],
      ['/ch/01/config/source', [oscInt(1)]],
      ['/ch/01/mix/on', [oscInt(1)]],
      ['/ch/01/mix/fader', [oscFloat(levelDbToFloat(-6))]],
      ['/ch/01/mix/st', [oscInt(1)]],
      ['/ch/01/mix/pan', [oscFloat(0.5)]],
      ['/ch/01/mix/mono', [oscInt(0)]],
      ['/ch/01/mix/mlevel', [oscFloat(0)]],
    ]);
    const read = (address: string): readonly OscArg[] | undefined =>
      state.get(address);

    it('writes a container as one line in display units', () => {
      expect(serializeContainer('/ch/01/mix', read)).toBe(
        '/ch/01/mix ON -6.0 ON +0 OFF -oo',
      );
      expect(serializeContainer('/ch/01/config', read)).toBe(
        '/ch/01/config "Kick In" 1 GN 1',
      );
    });

    it('omits a container it only knows part of', () => {
      // Half a line would be decoded positionally by whatever reads it back,
      // which is exactly how values end up on the wrong parameter.
      expect(serializeContainer('/ch/02/mix', read)).toBeUndefined();
    });

    it('writes a header and the containers it was given', () => {
      const text = serializeScnFile({
        name: 'Rock Night',
        note: 'FOH base',
        containers: ['/ch/01/config', '/ch/01/mix', '/ch/09/mix'],
        read,
      });

      expect(text.split('\n')[0]).toBe(
        '#2.7# "Rock Night" "FOH base" %000000000 1',
      );
      expect(text).toContain('/ch/01/mix ON -6.0 ON +0 OFF -oo');
      expect(text).not.toContain('/ch/09');
      expect(text.endsWith('\n')).toBe(true);
    });

    it('keeps quotes out of names, which the format cannot carry', () => {
      const text = serializeScnFile({
        name: 'The "Loud" Band',
        containers: [],
        read,
      });
      expect(text.split('\n')[0]).toBe(
        '#2.7# "The  Loud  Band" "" %000000000 1',
      );
    });

    it('carries unknown lines through untouched', () => {
      const text = serializeScnFile({
        name: 'x',
        containers: ['/ch/01/mix'],
        read,
        passthroughLines: ['/fx/1/type DLY'],
      });
      expect(text).toContain('/fx/1/type DLY');
    });
  });

  describe('round trip', () => {
    it('parses back exactly what it wrote', () => {
      const state = new Map<string, OscArg[]>([
        ['/ch/01/config/name', [oscString('Kick In')]],
        ['/ch/01/config/icon', [oscInt(1)]],
        ['/ch/01/config/color', [oscInt(2)]],
        ['/ch/01/config/source', [oscInt(1)]],
        ['/ch/01/mix/on', [oscInt(1)]],
        ['/ch/01/mix/fader', [oscFloat(levelDbToFloat(-6))]],
        ['/ch/01/mix/st', [oscInt(1)]],
        ['/ch/01/mix/pan', [oscFloat(0.5)]],
        ['/ch/01/mix/mono', [oscInt(0)]],
        ['/ch/01/mix/mlevel', [oscFloat(0)]],
      ]);

      const text = serializeScnFile({
        name: 'Round Trip',
        containers: ['/ch/01/config', '/ch/01/mix'],
        read: (address) => state.get(address),
      });
      const file = parseScnFile(text);

      expect(file.header.name).toBe('Round Trip');
      expect(human(file.values, '/ch/01/config/name')).toBe('Kick In');
      expect(human(file.values, '/ch/01/config/color')).toBe('GN');
      expect(human(file.values, '/ch/01/mix/fader')).toBe(-6);
      expect(human(file.values, '/ch/01/mix/on')).toBe(true);
      expect(file.rejectedLines).toEqual([]);
      expect(file.unknownLines).toEqual([]);
    });
  });
});
