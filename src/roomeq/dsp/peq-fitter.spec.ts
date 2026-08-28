import { describe, expect, it } from 'vitest';
import { MeasurementPoint } from '../measurement/measurement-parser.js';
import {
  DEFAULTS,
  fitPeq,
  logGrid,
  peakingResponseDb,
  responseOf,
  smooth,
} from './peq-fitter.js';

/** A measurement sweep with a resonance built into it. */
function sweep(shape: (hz: number) => number): MeasurementPoint[] {
  return logGrid(20, 20000, 400).map((hz) => ({ hz, db: 80 + shape(hz) }));
}

/** A bell of `gain` dB at `centre`, the thing a room resonance looks like. */
const bell =
  (centre: number, gain: number, q = 4) =>
  (hz: number): number =>
    peakingResponseDb(hz, centre, gain, q);

describe('room EQ fitting', () => {
  describe('peaking filter response', () => {
    it('is flat away from the centre and full gain at it', () => {
      expect(peakingResponseDb(1000, 1000, 6, 4)).toBeCloseTo(6, 6);
      expect(peakingResponseDb(20, 1000, 6, 4)).toBeCloseTo(0, 1);
      expect(peakingResponseDb(20000, 1000, 6, 4)).toBeCloseTo(0, 1);
    });

    it('is symmetric in log frequency', () => {
      const above = peakingResponseDb(2000, 1000, -6, 2);
      const below = peakingResponseDb(500, 1000, -6, 2);
      expect(above).toBeCloseTo(below, 6);
    });

    it('gets narrower as Q rises', () => {
      const wide = peakingResponseDb(1200, 1000, 6, 1);
      const narrow = peakingResponseDb(1200, 1000, 6, 8);
      expect(narrow).toBeLessThan(wide);
    });

    it('does nothing at zero gain', () => {
      expect(peakingResponseDb(1000, 1000, 0, 4)).toBe(0);
    });
  });

  describe('smoothing', () => {
    it('leaves a flat response flat', () => {
      const grid = logGrid(50, 5000, 40);
      const smoothed = smooth(
        sweep(() => 0),
        grid,
        6,
      );
      for (const db of smoothed) expect(db).toBeCloseTo(80, 6);
    });

    it('flattens a narrow null that only exists at the mic position', () => {
      // A one-point cancellation notch: real at the mic, absent a metre away.
      const points = sweep(() => 0);
      const victim = points.findIndex((point) => point.hz > 300);
      points[victim] = { ...points[victim], db: 50 };

      const grid = logGrid(200, 500, 20);
      const smoothed = smooth(points, grid, 6);
      // 30 dB in the raw data becomes a couple of dB after smoothing.
      expect(Math.min(...smoothed)).toBeGreaterThan(74);
    });

    it('keeps a broad resonance, which is what the room really does', () => {
      const points = sweep(bell(120, 9, 1.5));
      const grid = logGrid(60, 240, 30);
      const smoothed = smooth(points, grid, 6);
      expect(Math.max(...smoothed) - 80).toBeGreaterThan(6);
    });
  });

  describe('fitting', () => {
    it('finds a single resonance and inverts it', () => {
      const result = fitPeq(sweep(bell(160, 9, 4)), { bands: 6 });

      expect(result.bands.length).toBeGreaterThanOrEqual(1);
      const [first] = result.bands;
      expect(first.frequencyHz).toBeGreaterThan(130);
      expect(first.frequencyHz).toBeLessThan(200);
      expect(first.gainDb).toBeLessThan(-3);
    });

    it('leaves a flat room alone instead of spending bands on nothing', () => {
      const result = fitPeq(
        sweep(() => 0),
        { bands: 6 },
      );
      expect(result.bands).toHaveLength(0);
      expect(result.deviationAfterDb).toBeCloseTo(result.deviationBeforeDb, 2);
    });

    it('measurably flattens a room with several problems', () => {
      const measurement = sweep(
        (hz) =>
          bell(80, 8, 3)(hz) + bell(400, -6, 2)(hz) + bell(2500, 5, 5)(hz),
      );
      const result = fitPeq(measurement, { bands: 6 });

      expect(result.deviationAfterDb).toBeLessThan(
        result.deviationBeforeDb / 2,
      );
    });

    it('never boosts more than it is allowed to', () => {
      // A deep, broad suck-out that a naive fitter would try to fill.
      const result = fitPeq(sweep(bell(300, -18, 1.5)), {
        bands: 6,
        maxBoostDb: 6,
      });
      for (const band of result.bands)
        expect(band.gainDb).toBeLessThanOrEqual(6);
    });

    it('cuts harder than it boosts, because a cut costs no headroom', () => {
      const result = fitPeq(sweep(bell(200, 14, 3)), {
        bands: 6,
        maxBoostDb: 6,
        maxCutDb: 12,
      });
      expect(Math.min(...result.bands.map((band) => band.gainDb))).toBeLessThan(
        -6,
      );
    });

    it('stays inside the range EQ can actually fix', () => {
      const measurement = sweep(
        (hz) => bell(25, 12, 2)(hz) + bell(15000, 12, 2)(hz),
      );
      const result = fitPeq(measurement, { bands: 6, minHz: 40, maxHz: 8000 });

      for (const band of result.bands) {
        expect(band.frequencyHz).toBeGreaterThanOrEqual(40);
        expect(band.frequencyHz).toBeLessThanOrEqual(8000);
      }
    });

    it('uses no more bands than the strip has', () => {
      const measurement = sweep((hz) =>
        [60, 120, 250, 500, 1000, 2000, 4000, 6000].reduce(
          (sum, centre) => sum + bell(centre, 8, 6)(hz),
          0,
        ),
      );
      expect(
        fitPeq(measurement, { bands: 4 }).bands.length,
      ).toBeLessThanOrEqual(4);
      expect(
        fitPeq(measurement, { bands: 6 }).bands.length,
      ).toBeLessThanOrEqual(6);
    });

    it('spends its first band on the worst problem', () => {
      const measurement = sweep(
        (hz) => bell(100, 12, 3)(hz) + bell(3000, 3, 3)(hz),
      );
      const [first] = fitPeq(measurement, { bands: 6 }).bands;
      expect(first.frequencyHz).toBeLessThan(200);
    });

    it('keeps Q inside what the console can be set to', () => {
      const measurement = sweep(bell(1000, 10, 12));
      const result = fitPeq(measurement, { bands: 6, minQ: 0.5, maxQ: 8 });
      for (const band of result.bands) {
        expect(band.q).toBeGreaterThanOrEqual(0.5);
        expect(band.q).toBeLessThanOrEqual(8);
      }
    });

    it('returns before and after curves that agree with the filters', () => {
      const result = fitPeq(sweep(bell(160, 9, 4)), { bands: 6 });
      const applied = responseOf(result.bands, result.frequencies);

      expect(result.after).toHaveLength(result.before.length);
      expect(result.frequencies).toHaveLength(DEFAULTS.gridPoints);
      for (let i = 0; i < result.after.length; i += 1) {
        expect(result.after[i]).toBeCloseTo(result.before[i] + applied[i], 1);
      }
    });

    it('follows a house curve tilt when asked for one', () => {
      const flat = fitPeq(
        sweep(() => 0),
        { bands: 6, tiltDbPerOctave: -1 },
      );
      // A flat room against a tilted target needs work: highs come down.
      expect(flat.bands.length).toBeGreaterThan(0);
      expect(flat.target[0]).toBeGreaterThan(
        flat.target[flat.target.length - 1],
      );
    });
  });
});
