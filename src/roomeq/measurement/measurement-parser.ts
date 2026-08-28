/**
 * Reading a room measurement.
 *
 * REW's text export and a plain CSV are the two things an engineer actually
 * has on a laptop after walking a room with a measurement mic, so both are
 * accepted, and the differences between them (comment markers, delimiters,
 * headers, decimal commas) are handled here rather than asked about.
 *
 * The parser is strict about what it cannot fix: a file with two usable points,
 * or frequencies that go backwards, is rejected with a reason. Auto-EQ built on
 * a misread file produces a filter set that sounds worse than doing nothing.
 */

export interface MeasurementPoint {
  readonly hz: number;
  readonly db: number;
}

export interface Measurement {
  readonly points: readonly MeasurementPoint[];
  readonly source: 'rew' | 'csv';
  /** Free-text lines from the file header, kept for display. */
  readonly notes: readonly string[];
  readonly minHz: number;
  readonly maxHz: number;
}

export class MeasurementParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MeasurementParseError';
  }
}

/** Fewer points than this cannot describe a room. */
const MIN_POINTS = 16;

export function parseMeasurement(text: string): Measurement {
  const lines = text.split(/\r?\n/);
  const notes: string[] = [];
  const points: MeasurementPoint[] = [];
  let sawComment = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0) continue;

    // REW writes its metadata as `*` lines; some tools use `#` or `//`.
    if (line.startsWith('*') || line.startsWith('#') || line.startsWith('//')) {
      sawComment = true;
      const note = line.replace(/^[*#/]+\s*/, '').trim();
      if (note.length > 0) notes.push(note);
      continue;
    }

    const parsed = parseDataLine(line);
    if (!parsed) continue; // a header row such as "Frequency,SPL"
    points.push(parsed);
  }

  if (points.length < MIN_POINTS) {
    throw new MeasurementParseError(
      `found only ${points.length} usable data points — this does not look like a ` +
        `frequency response export. Expected lines of "frequency  level", as REW and most ` +
        `measurement tools write them.`,
    );
  }

  const sorted = [...points].sort((a, b) => a.hz - b.hz);
  const deduped = dedupe(sorted);

  return {
    points: deduped,
    source: sawComment ? 'rew' : 'csv',
    notes,
    minHz: deduped[0].hz,
    maxHz: deduped[deduped.length - 1].hz,
  };
}

/**
 * One data row: frequency first, level second, anything after (phase, weight)
 * ignored. Handles whitespace, comma, semicolon and tab delimiters.
 */
function parseDataLine(line: string): MeasurementPoint | undefined {
  const fields = line
    .split(/[;,\t]|\s+/)
    .map((field) => field.trim())
    .filter((field) => field.length > 0);

  if (fields.length < 2) return undefined;

  const hz = toNumber(fields[0]);
  const db = toNumber(fields[1]);
  if (hz === undefined || db === undefined) return undefined;
  // A measurement starts above DC and stops below the sample rate; anything
  // outside that is a column that happened to look numeric.
  if (!(hz > 0 && hz < 100_000) || !Number.isFinite(db)) return undefined;

  return { hz, db };
}

function toNumber(field: string): number | undefined {
  // Locales that write "1.234,5" are common in exported CSVs.
  const normalised = /^-?\d{1,3}(\.\d{3})+,\d+$/.test(field)
    ? field.replace(/\./g, '').replace(',', '.')
    : field.replace(',', '.');
  const value = Number(normalised);
  return Number.isFinite(value) ? value : undefined;
}

/** Averages duplicate frequencies rather than letting the last one win. */
function dedupe(points: readonly MeasurementPoint[]): MeasurementPoint[] {
  const out: MeasurementPoint[] = [];
  let index = 0;

  while (index < points.length) {
    const hz = points[index].hz;
    let sum = 0;
    let count = 0;
    while (index < points.length && points[index].hz === hz) {
      sum += points[index].db;
      count += 1;
      index += 1;
    }
    out.push({ hz, db: sum / count });
  }
  return out;
}
