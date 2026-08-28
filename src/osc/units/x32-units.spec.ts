import { describe, expect, it } from 'vitest';
import { decodePacket, encodeMessage, message } from '../codec/osc-codec.js';
import { argAsNumber, isMessage, oscFloat } from '../codec/osc-types.js';
import {
  COMP_RATIOS,
  MIN_FADER_DB,
  colorFromIndex,
  colorToIndex,
  compRatioFromIndex,
  compRatioToIndex,
  dbfsToMeter,
  eqFreqFromFloat,
  eqFreqToFloat,
  eqGainFromFloat,
  eqGainToFloat,
  eqQFromFloat,
  eqQToFloat,
  headampGainFromFloat,
  headampGainToFloat,
  holdMsFromFloat,
  holdMsToFloat,
  levelDbToFloat,
  levelFloatToDb,
  lowCutFreqFromFloat,
  lowCutFreqToFloat,
  meterToDbfs,
  mutedFromOnInt,
  mutedToOnInt,
  panFromFloat,
  panToFloat,
  releaseMsFromFloat,
  releaseMsToFloat,
} from './x32-units.js';

/** Sends a raw float through the wire encoder, as a real command would go. */
function throughFloat32(value: number): number {
  const decoded = decodePacket(encodeMessage(message('/x', oscFloat(value))));
  if (!isMessage(decoded)) throw new Error('expected a message');
  return argAsNumber(decoded.args[0]) ?? Number.NaN;
}

describe('x32 unit conversion', () => {
  describe('level taper (fader / send level)', () => {
    it('maps the documented segment boundaries', () => {
      expect(levelFloatToDb(1)).toBeCloseTo(10, 6);
      expect(levelFloatToDb(0.75)).toBeCloseTo(0, 6);
      expect(levelFloatToDb(0.5)).toBeCloseTo(-10, 6);
      expect(levelFloatToDb(0.25)).toBeCloseTo(-30, 6);
      expect(levelFloatToDb(0.0625)).toBeCloseTo(-60, 6);
      expect(levelFloatToDb(0)).toBe(MIN_FADER_DB);
    });

    it('maps -6 dB to 0.6 and back (acceptance criterion 3)', () => {
      expect(levelDbToFloat(-6)).toBeCloseTo(0.6, 6);
      expect(levelFloatToDb(0.6)).toBeCloseTo(-6, 6);
    });

    it('survives the float32 round trip the console imposes, within 0.1 dB', () => {
      for (let db = -90; db <= 10; db += 0.5) {
        const backAgain = levelFloatToDb(throughFloat32(levelDbToFloat(db)));
        expect(Math.abs(backAgain - db)).toBeLessThanOrEqual(0.1);
      }
    });

    it('round-trips every raw float back to itself', () => {
      for (let raw = 0; raw <= 1; raw += 0.001) {
        expect(levelDbToFloat(levelFloatToDb(raw))).toBeCloseTo(raw, 6);
      }
    });

    it('clamps out-of-range input instead of extrapolating', () => {
      expect(levelDbToFloat(+40)).toBe(1);
      expect(levelDbToFloat(-200)).toBe(0);
      expect(levelFloatToDb(2)).toBeCloseTo(10, 6);
      expect(levelFloatToDb(-1)).toBe(MIN_FADER_DB);
    });

    it('is monotonic across the whole range', () => {
      let previous = -Infinity;
      for (let raw = 0; raw <= 1; raw += 0.005) {
        const db = levelFloatToDb(raw);
        expect(db).toBeGreaterThanOrEqual(previous);
        previous = db;
      }
    });
  });

  describe('head amp gain', () => {
    it('spans -12 .. +60 dB linearly', () => {
      expect(headampGainFromFloat(0)).toBeCloseTo(-12, 6);
      expect(headampGainFromFloat(1)).toBeCloseTo(60, 6);
      expect(headampGainToFloat(24)).toBeCloseTo(0.5, 6);
    });

    it('round-trips in both directions', () => {
      for (let db = -12; db <= 60; db += 0.5) {
        expect(headampGainFromFloat(headampGainToFloat(db))).toBeCloseTo(db, 5);
      }
    });
  });

  describe('frequency tapers', () => {
    it('maps EQ frequency logarithmically over 20 Hz .. 20 kHz', () => {
      expect(eqFreqFromFloat(0)).toBeCloseTo(20, 6);
      expect(eqFreqFromFloat(1)).toBeCloseTo(20000, 3);
      // Half travel is the geometric mean, not the arithmetic one.
      expect(eqFreqFromFloat(0.5)).toBeCloseTo(Math.sqrt(20 * 20000), 3);
    });

    it('round-trips musically useful frequencies', () => {
      for (const hz of [
        20, 60, 100, 250, 440, 1000, 3150, 8000, 12500, 20000,
      ]) {
        expect(eqFreqFromFloat(eqFreqToFloat(hz))).toBeCloseTo(hz, 3);
      }
    });

    it('maps the low-cut filter over 20 .. 400 Hz', () => {
      expect(lowCutFreqFromFloat(0)).toBeCloseTo(20, 6);
      expect(lowCutFreqFromFloat(1)).toBeCloseTo(400, 6);
      expect(lowCutFreqFromFloat(lowCutFreqToFloat(100))).toBeCloseTo(100, 6);
    });
  });

  describe('EQ gain and Q', () => {
    it('maps EQ gain over -15 .. +15 dB', () => {
      expect(eqGainFromFloat(0.5)).toBeCloseTo(0, 6);
      expect(eqGainToFloat(15)).toBeCloseTo(1, 6);
      expect(eqGainFromFloat(eqGainToFloat(-4.5))).toBeCloseTo(-4.5, 6);
    });

    it('maps Q inversely: 0.0 is the widest setting on the console', () => {
      expect(eqQFromFloat(0)).toBeCloseTo(10, 6);
      expect(eqQFromFloat(1)).toBeCloseTo(0.3, 6);
      for (const q of [0.3, 0.5, 1, 2, 4.5, 10]) {
        expect(eqQFromFloat(eqQToFloat(q))).toBeCloseTo(q, 6);
      }
    });
  });

  describe('pan', () => {
    it('centres at 0.5 and spans -100 .. +100', () => {
      expect(panFromFloat(0.5)).toBeCloseTo(0, 6);
      expect(panToFloat(-100)).toBe(0);
      expect(panToFloat(100)).toBe(1);
      expect(panFromFloat(panToFloat(-35))).toBeCloseTo(-35, 6);
    });
  });

  describe('dynamics times', () => {
    it('maps hold logarithmically over 0.02 .. 2000 ms', () => {
      expect(holdMsFromFloat(0)).toBeCloseTo(0.02, 6);
      expect(holdMsFromFloat(1)).toBeCloseTo(2000, 3);
      expect(holdMsFromFloat(holdMsToFloat(250))).toBeCloseTo(250, 6);
    });

    it('maps release logarithmically over 5 .. 4000 ms', () => {
      expect(releaseMsFromFloat(0)).toBeCloseTo(5, 6);
      expect(releaseMsFromFloat(1)).toBeCloseTo(4000, 3);
      expect(releaseMsFromFloat(releaseMsToFloat(120))).toBeCloseTo(120, 6);
    });
  });

  describe('enumerations', () => {
    it('snaps a requested ratio to the nearest one the console offers', () => {
      expect(compRatioFromIndex(compRatioToIndex(4))).toBe(4);
      expect(compRatioFromIndex(compRatioToIndex(3.4))).toBe(3);
      expect(compRatioFromIndex(compRatioToIndex(999))).toBe(100);
      expect(compRatioToIndex(1.1)).toBe(0);
      expect(compRatioToIndex(100)).toBe(COMP_RATIOS.length - 1);
    });

    it('round-trips channel colours and clamps unknown indices', () => {
      expect(colorFromIndex(colorToIndex('GN'))).toBe('GN');
      expect(colorFromIndex(-5)).toBe('OFF');
      expect(colorFromIndex(999)).toBe('WHi');
    });
  });

  describe('metering', () => {
    it('converts linear meter samples to dBFS', () => {
      expect(meterToDbfs(1)).toBeCloseTo(0, 6);
      expect(meterToDbfs(0.5)).toBeCloseTo(-6.02, 2);
      expect(meterToDbfs(0)).toBe(-90);
    });

    it('round-trips dBFS through the linear representation', () => {
      for (const dbfs of [0, -3, -6, -12, -24, -48, -80]) {
        expect(meterToDbfs(dbfsToMeter(dbfs))).toBeCloseTo(dbfs, 4);
      }
    });
  });

  describe('mute polarity', () => {
    it('treats /mix/on as the inverse of muted', () => {
      expect(mutedToOnInt(true)).toBe(0);
      expect(mutedToOnInt(false)).toBe(1);
      expect(mutedFromOnInt(0)).toBe(true);
      expect(mutedFromOnInt(1)).toBe(false);
    });
  });
});
