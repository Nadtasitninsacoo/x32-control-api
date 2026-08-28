import { OscArg, OscMessage } from '../../osc/codec/osc-types.js';
import { HumanValue, paramFor, toHuman } from '../../osc/schema/x32-schema.js';
import { parseNodeDump } from './node-dump.parser.js';

/**
 * An in-memory mirror of one console's parameters.
 *
 * Filled once at connect time from `/node` subtree queries, then kept current
 * by the `/xremote` feed — the console pushes every change, including ones made
 * on the physical surface. Nothing re-polls the whole console: a full sweep
 * costs thousands of datagrams, and at the pacing the hardware tolerates that
 * is minutes of traffic that would starve operator commands.
 */

export type StateSource = 'sync' | 'feed' | 'local';

export interface StateEntry {
  readonly args: readonly OscArg[];
  readonly updatedAt: number;
  readonly source: StateSource;
}

export interface StateChange {
  readonly address: string;
  readonly args: readonly OscArg[];
  /** Human value when the address is in the schema, otherwise undefined. */
  readonly value: HumanValue | undefined;
  readonly previous: readonly OscArg[] | undefined;
  readonly source: StateSource;
  readonly at: number;
}

export type StateListener = (change: StateChange) => void;
export type Unsubscribe = () => void;

function argsEqual(a: readonly OscArg[], b: readonly OscArg[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((arg, i) => {
    const other = b[i];
    if (arg.type !== other.type) return false;
    if (arg.type === 'b' && other.type === 'b')
      return arg.value.equals(other.value);
    return arg.value === other.value;
  });
}

export class StateCache {
  private readonly entries = new Map<string, StateEntry>();
  private readonly listeners = new Set<StateListener>();

  private syncedAt: number | undefined;
  private feedAt: number | undefined;

  constructor(private readonly now: () => number = () => Date.now()) {}

  get size(): number {
    return this.entries.size;
  }

  /** When the last full `/node` sync completed. */
  get lastSyncAt(): number | undefined {
    return this.syncedAt;
  }

  /** When the last `/xremote` update arrived — the liveness signal that matters. */
  get lastFeedAt(): number | undefined {
    return this.feedAt;
  }

  has(address: string): boolean {
    return this.entries.has(address);
  }

  get(address: string): readonly OscArg[] | undefined {
    return this.entries.get(address)?.args;
  }

  entry(address: string): StateEntry | undefined {
    return this.entries.get(address);
  }

  /** Value in API units, for addresses the schema knows. */
  getValue(address: string): HumanValue | undefined {
    const args = this.get(address);
    const def = paramFor(address);
    if (!args || !def || args.length === 0) return undefined;
    return toHuman(def, args[0]);
  }

  /**
   * Records a value.
   * @returns true if it differed from what was already held.
   */
  set(
    address: string,
    args: readonly OscArg[],
    source: StateSource = 'feed',
  ): boolean {
    const at = this.now();
    if (source === 'feed') this.feedAt = at;

    const previous = this.entries.get(address);
    const changed = !previous || !argsEqual(previous.args, args);
    this.entries.set(address, { args, updatedAt: at, source });

    if (!changed) return false;

    const def = paramFor(address);
    const change: StateChange = {
      address,
      args,
      value: def && args.length > 0 ? toHuman(def, args[0]) : undefined,
      previous: previous?.args,
      source,
      at,
    };
    for (const listener of this.listeners) listener(change);
    return true;
  }

  /** Feeds one inbound OSC message into the mirror. */
  applyMessage(message: OscMessage, source: StateSource = 'feed'): boolean {
    // Replies with no arguments carry no state, and meter blobs are handled by
    // the metering pipeline, not the parameter mirror.
    if (message.args.length === 0) return false;
    if (message.address.startsWith('/meters')) return false;
    if (!message.address.startsWith('/')) return false;
    return this.set(message.address, message.args, source);
  }

  /**
   * Applies a `/node` dump.
   * @returns the addresses whose lines did not match the schema, so the caller
   *          can read those parameters individually instead.
   */
  applyNodeDump(
    dump: string,
    source: StateSource = 'sync',
  ): { applied: number; unparsed: string[] } {
    const parsed = parseNodeDump(dump);
    for (const [address, args] of parsed.values)
      this.set(address, args, source);
    return { applied: parsed.values.size, unparsed: [...parsed.unparsed] };
  }

  markSynced(): void {
    this.syncedAt = this.now();
  }

  clear(): void {
    this.entries.clear();
    this.syncedAt = undefined;
    this.feedAt = undefined;
  }

  /** Every known address under a prefix, with values in API units. */
  snapshot(prefix = '/'): Record<string, HumanValue | readonly OscArg[]> {
    const out: Record<string, HumanValue | readonly OscArg[]> = {};
    for (const [address, entry] of this.entries) {
      if (!address.startsWith(prefix)) continue;
      const def = paramFor(address);
      out[address] =
        def && entry.args.length > 0 ? toHuman(def, entry.args[0]) : entry.args;
    }
    return out;
  }

  /** Raw addresses currently mirrored, sorted. */
  addresses(prefix = '/'): string[] {
    return [...this.entries.keys()].filter((a) => a.startsWith(prefix)).sort();
  }

  subscribe(listener: StateListener): Unsubscribe {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
