import { describe, expect, it } from 'vitest';
import { oscFloat, oscInt, oscString } from '../codec/osc-types.js';
import {
  ParamDef,
  containerFor,
  formatNodeToken,
  fromHuman,
  paramFor,
  parseNodeToken,
  parseNumericToken,
  splitNodeLine,
  toHuman,
} from './x32-schema.js';

const def = (address: string): ParamDef => {
  const found = paramFor(address);
  if (!found) throw new Error(`no schema for ${address}`);
  return found;
};

describe('x32 parameter schema', () => {
  describe('address resolution', () => {
    it('resolves containers for every strip family', () => {
      for (const address of [
        '/ch/01/config',
        '/ch/32/mix',
        '/ch/01/mix/16',
        '/auxin/08/preamp',
        '/fxrtn/01/eq/4',
        '/bus/16/dyn',
        '/mtx/06/gate',
        '/main/st/mix',
        '/main/m/eq',
        '/dca/8',
        '/dca/1/config',
        '/headamp/031',
      ]) {
        expect(containerFor(address), address).toBeDefined();
      }
    });

    it('gives channels a source field and buses none', () => {
      expect(
        containerFor('/ch/01/config')?.children.map((c) => c.name),
      ).toEqual(['name', 'icon', 'color', 'source']);
      expect(
        containerFor('/bus/01/config')?.children.map((c) => c.name),
      ).toEqual(['name', 'icon', 'color']);
    });

    it('returns nothing for addresses outside the modelled surface', () => {
      expect(containerFor('/ch/33/mix')).toBeUndefined();
      expect(containerFor('/fx/1/par')).toBeUndefined();
      expect(containerFor('/nonsense')).toBeUndefined();
      expect(paramFor('/ch/01/mix/nosuchfield')).toBeUndefined();
    });

    it('resolves individual parameters', () => {
      expect(paramFor('/ch/01/mix/fader')?.kind).toBe('level');
      expect(paramFor('/ch/01/mix/on')?.kind).toBe('bool');
      expect(paramFor('/ch/01/config/name')?.kind).toBe('string');
      expect(paramFor('/ch/01/eq/2/f')?.unit).toBe('Hz');
      expect(paramFor('/headamp/000/gain')?.unit).toBe('dB');
    });
  });

  describe('raw <-> API units', () => {
    it('converts a fader both ways', () => {
      const fader = def('/ch/01/mix/fader');
      expect(toHuman(fader, oscFloat(0.6))).toBe(-6);
      expect(fromHuman(fader, -6)).toEqual({ type: 'f', value: 0.6 });
    });

    it('converts mute polarity as ON/OFF, not as muted', () => {
      const on = def('/ch/01/mix/on');
      expect(toHuman(on, oscInt(1))).toBe(true);
      expect(toHuman(on, oscInt(0))).toBe(false);
      expect(fromHuman(on, true)).toEqual({ type: 'i', value: 1 });
    });

    it('converts enums to their console tokens', () => {
      const color = def('/ch/01/config/color');
      expect(toHuman(color, oscInt(2))).toBe('GN');
      expect(fromHuman(color, 'GN')).toEqual({ type: 'i', value: 2 });

      const type = def('/ch/01/eq/1/type');
      expect(toHuman(type, oscInt(2))).toBe('PEQ');
    });

    it('snaps a compressor ratio to the nearest the console offers', () => {
      const ratio = def('/ch/01/dyn/ratio');
      expect(fromHuman(ratio, 4)).toEqual({ type: 'i', value: 6 });
      expect(toHuman(ratio, oscInt(6))).toBe(4);
      expect(toHuman(ratio, fromHuman(ratio, 3.4))).toBe(3);
    });

    it('keeps names as strings', () => {
      const name = def('/ch/01/config/name');
      expect(toHuman(name, oscString('Kick In'))).toBe('Kick In');
      expect(fromHuman(name, 'Kick In')).toEqual({
        type: 's',
        value: 'Kick In',
      });
    });

    it('round-trips every numeric parameter through the raw form', () => {
      const cases: [string, number][] = [
        ['/ch/01/mix/fader', -6],
        ['/ch/01/mix/pan', -35],
        ['/ch/01/preamp/trim', 6],
        ['/ch/01/preamp/hpf', 100],
        ['/ch/01/gate/thr', -40],
        ['/ch/01/gate/range', 24],
        ['/ch/01/dyn/thr', -18],
        ['/ch/01/dyn/mgain', 6],
        ['/ch/01/dyn/release', 120],
        ['/ch/01/eq/1/f', 3150],
        ['/ch/01/eq/1/g', -4.5],
        ['/ch/01/eq/1/q', 2],
        ['/headamp/000/gain', 24],
      ];
      for (const [address, value] of cases) {
        const parameter = def(address);
        expect(
          toHuman(parameter, fromHuman(parameter, value)),
          address,
        ).toBeCloseTo(value, 1);
      }
    });
  });

  describe('/node display tokens', () => {
    it('prints levels in dB and a closed fader as -oo', () => {
      const fader = def('/ch/01/mix/fader');
      expect(formatNodeToken(fader, oscFloat(0.6))).toBe('-6.0');
      expect(formatNodeToken(fader, oscFloat(0))).toBe('-oo');
      expect(formatNodeToken(fader, oscFloat(0.75))).toBe('0.0');
    });

    it('prints booleans as ON/OFF and strings quoted', () => {
      expect(formatNodeToken(def('/ch/01/mix/on'), oscInt(1))).toBe('ON');
      expect(formatNodeToken(def('/ch/01/mix/on'), oscInt(0))).toBe('OFF');
      expect(
        formatNodeToken(def('/ch/01/config/name'), oscString('Kick')),
      ).toBe('"Kick"');
    });

    it('prints dB parameters with an explicit sign', () => {
      expect(formatNodeToken(def('/ch/01/preamp/trim'), oscFloat(0.5))).toBe(
        '+0.0',
      );
      expect(formatNodeToken(def('/headamp/000/gain'), oscFloat(0))).toBe(
        '-12.0',
      );
    });

    it('parses a printed token back to the same raw value', () => {
      for (const [address, raw] of [
        ['/ch/01/mix/fader', 0.6],
        ['/ch/01/mix/on', 1],
        ['/ch/01/eq/1/f', 0.5],
        ['/ch/01/gate/thr', 0.25],
      ] as [string, number][]) {
        const parameter = def(address);
        const arg = parameter.osc === 'i' ? oscInt(raw) : oscFloat(raw);
        const printed = formatNodeToken(parameter, arg);
        const parsed = parseNodeToken(parameter, printed);
        expect(
          toHuman(parameter, parsed),
          `${address} via "${printed}"`,
        ).toBeCloseTo(Number(toHuman(parameter, arg)), 1);
      }
    });

    it('reads the console frequency shorthand', () => {
      expect(parseNumericToken('1k00')).toBe(1000);
      expect(parseNumericToken('12k5')).toBe(12500);
      expect(parseNumericToken('3k15')).toBeCloseTo(3150, 6);
      expect(parseNumericToken('100.0')).toBe(100);
      expect(parseNumericToken('-6.0')).toBe(-6);
      expect(parseNumericToken('-oo')).toBe(-90);
      expect(parseNumericToken('rubbish')).toBe(0);
    });
  });

  describe('splitNodeLine', () => {
    it('keeps quoted names whole and tolerates the console spacing', () => {
      expect(splitNodeLine('/ch/01/config "Kick In"   1 GN 1')).toEqual({
        address: '/ch/01/config',
        tokens: ['"Kick In"', '1', 'GN', '1'],
      });
    });

    it('handles the wide spacing the console pads values with', () => {
      expect(
        splitNodeLine('/ch/01/mix ON   -6.0 ON +0 OFF   -oo')?.tokens,
      ).toEqual(['ON', '-6.0', 'ON', '+0', 'OFF', '-oo']);
    });

    it('ignores anything that is not a node line', () => {
      expect(splitNodeLine('')).toBeUndefined();
      expect(splitNodeLine('not a node line')).toBeUndefined();
    });
  });
});
