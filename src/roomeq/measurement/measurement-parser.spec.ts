import { describe, expect, it } from 'vitest';
import {
  MeasurementParseError,
  parseMeasurement,
} from './measurement-parser.js';

/** Enough rows to look like a real sweep. */
function rows(
  format: (hz: number, db: number) => string,
  count = 40,
): string[] {
  return Array.from({ length: count }, (_, i) => {
    const hz = 20 * 1.2 ** i;
    return format(
      Number(hz.toFixed(3)),
      Number((80 + Math.sin(i) * 3).toFixed(3)),
    );
  });
}

describe('measurement files', () => {
  describe('REW text export', () => {
    const rew = [
      '* Measurement data measured by REW V5.20',
      '* Dated: 12-Aug-2026 19:42:03',
      '*',
      '* Freq(Hz) SPL(dB) Phase(degrees)',
      ...rows((hz, db) => `${hz}  ${db}  12.5`),
    ].join('\n');

    it('reads frequency and level, ignoring phase', () => {
      const measurement = parseMeasurement(rew);
      expect(measurement.source).toBe('rew');
      expect(measurement.points).toHaveLength(40);
      expect(measurement.points[0].hz).toBeCloseTo(20, 3);
      expect(measurement.points[0].db).toBeCloseTo(80, 3);
    });

    it('keeps the header lines for display', () => {
      const measurement = parseMeasurement(rew);
      expect(measurement.notes[0]).toContain('REW V5.20');
    });

    it('reports the range it covers', () => {
      const measurement = parseMeasurement(rew);
      expect(measurement.minHz).toBeCloseTo(20, 3);
      expect(measurement.maxHz).toBeGreaterThan(1000);
    });
  });

  describe('CSV', () => {
    it('reads a comma-separated file with a header row', () => {
      const csv = ['Frequency,SPL', ...rows((hz, db) => `${hz},${db}`)].join(
        '\n',
      );
      const measurement = parseMeasurement(csv);
      expect(measurement.source).toBe('csv');
      expect(measurement.points).toHaveLength(40);
    });

    it('reads semicolons and tabs', () => {
      expect(
        parseMeasurement(rows((hz, db) => `${hz};${db}`).join('\n')).points,
      ).toHaveLength(40);
      expect(
        parseMeasurement(rows((hz, db) => `${hz}\t${db}`).join('\n')).points,
      ).toHaveLength(40);
    });

    it('reads a decimal comma, which exported CSVs are full of', () => {
      const text = rows(
        (hz, db) =>
          `${String(hz).replace('.', ',')};${String(db).replace('.', ',')}`,
      ).join('\n');
      const measurement = parseMeasurement(text);
      expect(measurement.points[0].hz).toBeCloseTo(20, 3);
    });
  });

  describe('cleaning up', () => {
    it('sorts by frequency', () => {
      const text = [...rows((hz, db) => `${hz} ${db}`)].reverse().join('\n');
      const measurement = parseMeasurement(text);
      for (let i = 1; i < measurement.points.length; i += 1) {
        expect(measurement.points[i].hz).toBeGreaterThan(
          measurement.points[i - 1].hz,
        );
      }
    });

    it('averages duplicate frequencies rather than keeping the last one', () => {
      const text = [...rows((hz, db) => `${hz} ${db}`), '20 70', '20 90'].join(
        '\n',
      );
      const measurement = parseMeasurement(text);
      const first = measurement.points.filter((point) => point.hz === 20);
      expect(first).toHaveLength(1);
      // 80 from the sweep, plus 70 and 90.
      expect(first[0].db).toBeCloseTo(80, 3);
    });

    it('skips blank lines and comment markers of every flavour', () => {
      const text = [
        '# a comment',
        '// another',
        '',
        '   ',
        ...rows((hz, db) => `${hz} ${db}`),
      ].join('\n');
      expect(parseMeasurement(text).points).toHaveLength(40);
    });
  });

  describe('refusing what it cannot read', () => {
    it('rejects a file with too few points to describe a room', () => {
      expect(() => parseMeasurement('100 80\n200 82')).toThrow(
        MeasurementParseError,
      );
      expect(() => parseMeasurement('')).toThrow(
        /does not look like a frequency response/,
      );
    });

    it('rejects something that is not a measurement at all', () => {
      expect(() => parseMeasurement('{"hello":"world"}')).toThrow(
        MeasurementParseError,
      );
    });

    it('ignores rows whose frequency could not be a frequency', () => {
      const text = [
        '0 80',
        '-5 80',
        '999999 80',
        ...rows((hz, db) => `${hz} ${db}`),
      ].join('\n');
      const measurement = parseMeasurement(text);
      expect(measurement.points).toHaveLength(40);
      expect(measurement.points.every((point) => point.hz > 0)).toBe(true);
    });
  });
});
