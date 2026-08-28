import { OscArg } from '../../osc/codec/osc-types.js';
import {
  containerFor,
  paramFor,
  parseNodeToken,
  splitNodeLine,
} from '../../osc/schema/x32-schema.js';

/**
 * Turns a `/node` reply back into raw parameter values.
 *
 * The console answers a `/node` query with one text line per node, printed in
 * *display* units:
 *
 *   /ch/01/config "Kick In" 1 GN 1
 *   /ch/01/mix ON   -6.0 ON +0 OFF   -oo
 *
 * Positional decoding is only as good as the field ordering in the schema, and
 * that ordering comes from unofficial documentation. So a line whose token
 * count does not match the schema is **reported, never guessed at**: the state
 * cache falls back to reading those parameters one by one, which is slower but
 * always right.
 */

export interface NodeLineResult {
  readonly address: string;
  /** Fully-qualified parameter address -> raw value. Empty when `ok` is false. */
  readonly values: ReadonlyMap<string, OscArg[]>;
  readonly ok: boolean;
  /** Why the line could not be trusted, when `ok` is false. */
  readonly reason?: string;
}

export interface NodeDumpResult {
  readonly lines: readonly NodeLineResult[];
  readonly values: ReadonlyMap<string, OscArg[]>;
  /** Addresses of lines that did not match the schema. */
  readonly unparsed: readonly string[];
}

export function parseNodeLine(line: string): NodeLineResult | undefined {
  const split = splitNodeLine(line);
  if (!split) return undefined;
  const { address, tokens } = split;

  // A leaf query (`/node ch/01/mix/fader`) prints the single value.
  const leaf = paramFor(address);
  if (leaf) {
    if (tokens.length !== 1) {
      return {
        address,
        values: new Map(),
        ok: false,
        reason: `expected 1 value for ${address}, got ${tokens.length}`,
      };
    }
    return {
      address,
      values: new Map([[address, [parseNodeToken(leaf, tokens[0])]]]),
      ok: true,
    };
  }

  const container = containerFor(address);
  if (!container) {
    return {
      address,
      values: new Map(),
      ok: false,
      reason: `no schema for ${address}`,
    };
  }

  if (tokens.length !== container.children.length) {
    return {
      address,
      values: new Map(),
      ok: false,
      reason:
        `${address}: schema expects ${container.children.length} values ` +
        `(${container.children.map((c) => c.name).join(', ')}) but the console sent ` +
        `${tokens.length}`,
    };
  }

  const values = new Map<string, OscArg[]>();
  container.children.forEach((child, index) => {
    values.set(`${address}/${child.name}`, [
      parseNodeToken(child, tokens[index]),
    ]);
  });
  return { address, values, ok: true };
}

export function parseNodeDump(dump: string): NodeDumpResult {
  const lines: NodeLineResult[] = [];
  const values = new Map<string, OscArg[]>();
  const unparsed: string[] = [];

  for (const raw of dump.split('\n')) {
    if (raw.trim().length === 0) continue;
    const result = parseNodeLine(raw);
    if (!result) continue;
    lines.push(result);
    if (result.ok) {
      for (const [address, args] of result.values) values.set(address, args);
    } else {
      unparsed.push(result.address);
    }
  }

  return { lines, values, unparsed };
}
