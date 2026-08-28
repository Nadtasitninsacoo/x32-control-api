import { OscArg } from '../../osc/codec/osc-types.js';
import {
  containerFor,
  formatNodeToken,
  paramFor,
} from '../../osc/schema/x32-schema.js';
import { parseNodeLine } from '../../console/state/node-dump.parser.js';

/**
 * The X32 `.scn` scene file.
 *
 * A scene file is a header line followed by one `/node`-style line per node —
 * the same display-unit text the console answers `/node` queries with. That is
 * why this module is thin: the parser and the formatter already exist, and a
 * scene file is just that format written down.
 *
 *   #2.7# "Rock Night" "FOH base" %000000000 1
 *   /ch/01/config "Kick In" 1 GN 1
 *   /ch/01/mix ON -6.0 ON +0 OFF -oo
 *
 * **An exported file is not a byte-identical console scene.** It carries the
 * mixing surface this project models — strips, sends, processing — and not
 * routing, effects racks, or the recorder. Loading one on a console applies the
 * lines it contains and leaves everything else as it was, which is the safe
 * direction to be incomplete in, but it does mean an exported file is a mixing
 * snapshot rather than a full show backup.
 */

export interface ScnHeader {
  /** Firmware version the file declares, e.g. `2.7`. */
  readonly version: string;
  readonly name: string;
  readonly note: string;
  /** Safe/parameter bitmask the console writes, kept verbatim. */
  readonly flags: string;
  readonly kind: number;
}

export interface ScnFile {
  readonly header: ScnHeader;
  /** Parameter address -> raw value, ready for the console or the mirror. */
  readonly values: ReadonlyMap<string, OscArg[]>;
  /** Lines this project has no schema for, kept verbatim and unmodified. */
  readonly unknownLines: readonly string[];
  /** Lines whose value count disagreed with the schema — never guessed at. */
  readonly rejectedLines: readonly string[];
}

export const DEFAULT_SCN_VERSION = '2.7';

const HEADER = /^#([\d.]+)#\s+"([^"]*)"\s+"([^"]*)"\s+(%\S+)\s+(\d+)/;

export class ScnParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ScnParseError';
  }
}

export function parseScnFile(text: string): ScnFile {
  const lines = text.split(/\r?\n/);
  const headerLine = lines.find((line) => line.trim().length > 0);
  if (!headerLine) throw new ScnParseError('the file is empty');

  const match = HEADER.exec(headerLine.trim());
  if (!match) {
    throw new ScnParseError(
      `not an X32 scene file: the first line should look like ` +
        `#2.7# "Name" "Note" %000000000 1, got ${JSON.stringify(headerLine.slice(0, 60))}`,
    );
  }

  const header: ScnHeader = {
    version: match[1],
    name: match[2],
    note: match[3],
    flags: match[4],
    kind: Number(match[5]),
  };

  const values = new Map<string, OscArg[]>();
  const unknownLines: string[] = [];
  const rejectedLines: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith('#')) continue;

    const parsed = parseNodeLine(line);
    if (!parsed) {
      unknownLines.push(line);
      continue;
    }
    if (!parsed.ok) {
      // Same rule as a live /node dump: a line that does not match the schema
      // is never decoded by position, because every value after a mismatch
      // would land on the wrong parameter.
      (parsed.reason?.startsWith('no schema')
        ? unknownLines
        : rejectedLines
      ).push(line);
      continue;
    }
    for (const [address, args] of parsed.values) values.set(address, args);
  }

  return { header, values, unknownLines, rejectedLines };
}

export interface SerializeScnOptions {
  readonly name: string;
  readonly note?: string;
  readonly version?: string;
  readonly flags?: string;
  readonly kind?: number;
  /**
   * Container addresses to write, in order. Containers with no known values are
   * skipped rather than written as defaults — an absent line leaves the console
   * parameter untouched, an invented one changes it.
   */
  readonly containers: readonly string[];
  /** Looks up a parameter's current raw value. */
  readonly read: (address: string) => readonly OscArg[] | undefined;
  /** Lines carried over verbatim from an imported file. */
  readonly passthroughLines?: readonly string[];
}

export function serializeScnFile(options: SerializeScnOptions): string {
  const header =
    `#${options.version ?? DEFAULT_SCN_VERSION}# ` +
    `"${sanitize(options.name)}" "${sanitize(options.note ?? '')}" ` +
    `${options.flags ?? '%000000000'} ${options.kind ?? 1}`;

  const lines: string[] = [header];

  for (const container of options.containers) {
    const line = serializeContainer(container, options.read);
    if (line) lines.push(line);
  }

  for (const passthrough of options.passthroughLines ?? [])
    lines.push(passthrough);

  return `${lines.join('\n')}\n`;
}

/** One `/node`-style line, or undefined when a value is missing. */
export function serializeContainer(
  container: string,
  read: (address: string) => readonly OscArg[] | undefined,
): string | undefined {
  const leaf = paramFor(container);
  if (leaf) {
    const args = read(container);
    return args && args.length > 0
      ? `${container} ${formatNodeToken(leaf, args[0])}`
      : undefined;
  }

  const def = containerFor(container);
  if (!def) return undefined;

  const tokens: string[] = [];
  for (const child of def.children) {
    const args = read(`${container}/${child.name}`);
    // A partial container is not written at all: half a line would be decoded
    // positionally by whatever reads it back.
    if (!args || args.length === 0) return undefined;
    tokens.push(formatNodeToken(child, args[0]));
  }
  return `${container} ${tokens.join(' ')}`;
}

/** Scene names and notes are quoted in the file, so quotes cannot survive. */
function sanitize(value: string): string {
  return value.replace(/["\r\n]/g, ' ').trim();
}
