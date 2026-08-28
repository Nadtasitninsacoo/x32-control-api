import { describe, expect, it } from 'vitest';
import { toHuman, paramFor } from '../../osc/schema/x32-schema.js';
import { parseNodeDump, parseNodeLine } from './node-dump.parser.js';

/** Reads a parsed value back in API units, the way the state cache will. */
function human(
  values: ReadonlyMap<string, readonly { type: string }[]>,
  address: string,
): unknown {
  const args = values.get(address);
  const def = paramFor(address);
  if (!args || !def) return undefined;
  return toHuman(def, args[0] as never);
}

describe('/node dump parser', () => {
  it('decodes a mix container printed in display units', () => {
    // Spacing here is the console's: values are padded, not single-spaced.
    const result = parseNodeLine('/ch/01/mix ON   -6.0 ON +0 OFF   -oo');
    expect(result?.ok).toBe(true);

    const values = result?.values ?? new Map();
    expect(human(values, '/ch/01/mix/on')).toBe(true);
    expect(human(values, '/ch/01/mix/fader')).toBe(-6);
    expect(human(values, '/ch/01/mix/st')).toBe(true);
    expect(human(values, '/ch/01/mix/pan')).toBe(0);
    expect(human(values, '/ch/01/mix/mono')).toBe(false);
    expect(human(values, '/ch/01/mix/mlevel')).toBe(-90);
  });

  it('keeps a quoted channel name intact', () => {
    const result = parseNodeLine('/ch/01/config "Kick In" 1 GN 1');
    expect(result?.ok).toBe(true);
    expect(human(result?.values ?? new Map(), '/ch/01/config/name')).toBe(
      'Kick In',
    );
    expect(human(result?.values ?? new Map(), '/ch/01/config/color')).toBe(
      'GN',
    );
    expect(human(result?.values ?? new Map(), '/ch/01/config/source')).toBe(1);
  });

  it('decodes an EQ band, including the console frequency shorthand', () => {
    const result = parseNodeLine('/ch/01/eq/2 PEQ 1k00 -4.5 2.00');
    expect(result?.ok).toBe(true);

    const values = result?.values ?? new Map();
    expect(human(values, '/ch/01/eq/2/type')).toBe('PEQ');
    expect(human(values, '/ch/01/eq/2/f')).toBeCloseTo(1000, 0);
    expect(human(values, '/ch/01/eq/2/g')).toBeCloseTo(-4.5, 1);
    expect(human(values, '/ch/01/eq/2/q')).toBeCloseTo(2, 1);
  });

  it('decodes a single-value leaf query', () => {
    const result = parseNodeLine('/ch/01/mix/fader -6.0');
    expect(result?.ok).toBe(true);
    expect(human(result?.values ?? new Map(), '/ch/01/mix/fader')).toBe(-6);
  });

  it('reports a container whose value count does not match the schema', () => {
    // A firmware that prints one extra field must never be decoded by
    // position: every value after the mismatch would land on the wrong
    // parameter, and a wrong fader is a wrong show.
    const result = parseNodeLine('/ch/01/mix ON -6.0 ON +0 OFF -oo EXTRA');
    expect(result?.ok).toBe(false);
    expect(result?.values.size).toBe(0);
    expect(result?.reason).toMatch(/schema expects 6 values/);
  });

  it('reports a leaf with the wrong number of values', () => {
    const result = parseNodeLine('/ch/01/mix/fader -6.0 ON');
    expect(result?.ok).toBe(false);
    expect(result?.reason).toMatch(/expected 1 value/);
  });

  it('reports an address it has no schema for', () => {
    const result = parseNodeLine('/fx/1/par 0.5 0.5');
    expect(result?.ok).toBe(false);
    expect(result?.reason).toMatch(/no schema/);
  });

  it('ignores lines that are not node lines', () => {
    expect(parseNodeLine('')).toBeUndefined();
    expect(parseNodeLine('  ')).toBeUndefined();
    expect(parseNodeLine('node')).toBeUndefined();
  });

  it('parses a multi-line dump and separates what it could not decode', () => {
    const dump = [
      '/ch/01/config "Kick In" 1 GN 1',
      '/ch/01/mix ON -6.0 ON +0 OFF -oo',
      '/ch/01/mix BROKEN',
      '/fx/1/par 0.5',
      '',
    ].join('\n');

    const result = parseNodeDump(dump);
    expect(result.values.size).toBe(10);
    expect(result.unparsed).toEqual(['/ch/01/mix', '/fx/1/par']);
    expect(human(result.values, '/ch/01/config/name')).toBe('Kick In');
  });
});
