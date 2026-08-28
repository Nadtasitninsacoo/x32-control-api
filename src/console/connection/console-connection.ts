import { Logger } from '@nestjs/common';
import { argAsString } from '../../osc/codec/osc-types.js';
import { OscClient } from '../../osc/client/osc-client.js';
import { XRemoteHeartbeatService } from '../../osc/heartbeat/xremote-heartbeat.service.js';
import { OscPriority } from '../../osc/rate-limit/osc-rate-limiter.js';
import { OscEndpoint } from '../../osc/transport/osc-transport.js';
import { containerFor } from '../../osc/schema/x32-schema.js';
import {
  ConnectionState,
  ConsoleInfo,
  ConsoleStatus,
  SyncDepth,
  SyncReport,
} from '../console.types.js';
import { StateCache } from '../state/state-cache.js';
import { syncStages } from '../state/sync-paths.js';
import { BackoffOptions, ExponentialBackoff } from './reconnect-policy.js';

export interface ConsoleConnectionOptions {
  readonly id: string;
  readonly endpoint: OscEndpoint;
  /** How often to check the console is still answering. */
  readonly probeIntervalMs: number;
  readonly probeTimeoutMs: number;
  /** Consecutive unanswered probes before the link counts as lost. */
  readonly maxMissedProbes: number;
  readonly reconnect: BackoffOptions;
  readonly syncDepth: SyncDepth;
  readonly dryRun?: boolean;
}

export type StateChangeListener = (
  state: ConnectionState,
  previous: ConnectionState,
) => void;

export class ConsoleUnreachableError extends Error {
  constructor(endpoint: OscEndpoint, cause?: unknown) {
    super(
      `console at ${endpoint.host}:${endpoint.port} did not answer` +
        (cause instanceof Error ? `: ${cause.message}` : ''),
    );
    this.name = 'ConsoleUnreachableError';
  }
}

/** How many `/node` queries may be outstanding during a sync. */
const SYNC_CONCURRENCY = 8;

/** Runs `worker` over `items`, keeping at most `limit` in flight. */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const runners = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const index = next;
        next += 1;
        await worker(items[index]);
      }
    },
  );
  await Promise.all(runners);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });

/**
 * One console, kept connected.
 *
 * UDP has no notion of a broken connection, so liveness is inferred: a small
 * `/xinfo` probe goes out every couple of seconds, and a run of unanswered
 * probes moves the link into reconnecting, where it retries with capped
 * backoff. On the way back it re-subscribes to `/xremote` and re-syncs the
 * mirror, because every change made while the link was down was missed.
 */
export class ConsoleConnection {
  private readonly logger: Logger;
  private readonly backoff: ExponentialBackoff;
  private readonly listeners = new Set<StateChangeListener>();

  readonly cache: StateCache;

  private connectionState: ConnectionState = 'disconnected';
  private consoleInfo: ConsoleInfo | undefined;
  private probeTimer: NodeJS.Timeout | undefined;
  private missed = 0;
  private reconnectLoop: Promise<void> | undefined;
  private closing = false;
  private deepSync: Promise<void> | undefined;

  constructor(
    private readonly options: ConsoleConnectionOptions,
    private readonly client: OscClient,
    private readonly heartbeat: XRemoteHeartbeatService,
    cache: StateCache = new StateCache(),
  ) {
    this.logger = new Logger(`Console:${options.id}`);
    this.backoff = new ExponentialBackoff(options.reconnect);
    this.cache = cache;
  }

  get id(): string {
    return this.options.id;
  }

  get endpoint(): OscEndpoint {
    return this.options.endpoint;
  }

  get state(): ConnectionState {
    return this.connectionState;
  }

  get info(): ConsoleInfo | undefined {
    return this.consoleInfo;
  }

  get osc(): OscClient {
    return this.client;
  }

  /** Resolves when the background stages of the initial sync have finished. */
  get syncSettled(): Promise<void> {
    return this.deepSync ?? Promise.resolve();
  }

  status(): ConsoleStatus {
    return {
      id: this.id,
      state: this.connectionState,
      endpoint: this.options.endpoint,
      info: this.consoleInfo,
      cachedAddresses: this.cache.size,
      lastSyncAt: this.cache.lastSyncAt,
      lastFeedAt: this.cache.lastFeedAt,
      missedProbes: this.missed,
      reconnectAttempts: this.backoff.attempt,
      dryRun: this.options.dryRun ?? false,
    };
  }

  onStateChange(listener: StateChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Opens the socket, identifies the console and fills the state mirror. */
  async connect(): Promise<ConsoleInfo> {
    if (this.connectionState === 'connected') {
      return this.consoleInfo ?? (await this.identify());
    }
    this.closing = false;
    this.setState('connecting');

    await this.client.open();
    this.client.onMessage((message) => {
      this.cache.applyMessage(message);
    });

    try {
      this.consoleInfo = await this.identify();
    } catch (error) {
      this.setState('disconnected');
      throw new ConsoleUnreachableError(this.options.endpoint, error);
    }

    this.heartbeat.register(this.client);

    this.setState('syncing');
    await this.sync('surface');
    this.setState('connected');
    this.startProbing();

    this.deepSync = this.runDeepSync();
    return this.consoleInfo;
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.stopProbing();
    this.heartbeat.unregister(this.id);
    await this.client.close();
    this.setState('disconnected');
  }

  /** Reads `/info` and merges it with the endpoint. */
  async identify(): Promise<ConsoleInfo> {
    const reply = await this.client.get('/info', {
      timeoutMs: this.options.probeTimeoutMs,
      priority: OscPriority.Housekeeping,
    });
    return {
      host: this.options.endpoint.host,
      port: this.options.endpoint.port,
      serverVersion: argAsString(reply.args[0]) ?? '',
      name: argAsString(reply.args[1]) ?? '',
      model: argAsString(reply.args[2]) ?? '',
      firmware: argAsString(reply.args[3]) ?? '',
    };
  }

  /**
   * Fills the mirror for one stage with `/node` subtree queries.
   *
   * A dump the schema cannot decode positionally is never guessed at: those
   * containers are re-read parameter by parameter instead, so a firmware whose
   * field order differs from the schema is slow, not wrong.
   */
  async sync(depth: SyncDepth): Promise<SyncReport> {
    const started = Date.now();
    const stage = syncStages(depth).find((s) => s.depth === depth);
    const paths = stage?.paths ?? [];

    let applied = 0;
    let failed = 0;
    let fallbackReads = 0;
    const unparsed: string[] = [];

    const queryOne = async (path: string): Promise<void> => {
      if (this.closing) return;
      try {
        const reply = await this.client.nodeQuery(path.replace(/^\//, ''), {
          priority: OscPriority.Polling,
        });
        const dump = argAsString(reply.args[0]) ?? '';
        const result = this.cache.applyNodeDump(dump);
        applied += result.applied;

        for (const address of result.unparsed) {
          unparsed.push(address);
          fallbackReads += await this.readContainerIndividually(address);
        }
      } catch {
        // A path this console model does not have simply never answers.
        failed += 1;
      }
    };

    // A handful of queries in flight at once. The rate limiter still decides
    // how fast datagrams actually leave; this only stops one unanswered path
    // from adding its full timeout to the wall clock of every path behind it.
    // Concurrency is safe even though every /node reply lands on the same
    // address: each dump names the node it describes, so a reply is stored
    // where it belongs regardless of which query it is paired with.
    await runWithConcurrency(paths, SYNC_CONCURRENCY, queryOne);

    if (depth === 'surface') this.cache.markSynced();

    const report: SyncReport = {
      depth,
      queries: paths.length,
      applied,
      unparsed,
      fallbackReads,
      failed,
      durationMs: Date.now() - started,
    };
    this.logger.log(
      `sync(${depth}): ${applied} values from ${paths.length} queries in ${report.durationMs}ms` +
        (failed ? `, ${failed} unanswered` : '') +
        (unparsed.length
          ? `, ${unparsed.length} containers re-read individually`
          : ''),
    );
    return report;
  }

  /** Reads each child of a container one at a time. Returns how many succeeded. */
  private async readContainerIndividually(container: string): Promise<number> {
    const def = containerFor(container);
    if (!def) return 0;
    let read = 0;
    for (const child of def.children) {
      const address = `${container}/${child.name}`;
      try {
        const reply = await this.client.get(address, {
          priority: OscPriority.Polling,
        });
        if (reply.args.length > 0) {
          this.cache.set(address, reply.args, 'sync');
          read += 1;
        }
      } catch {
        // Leave it absent rather than store a guess.
      }
    }
    return read;
  }

  private async runDeepSync(): Promise<void> {
    for (const stage of syncStages(this.options.syncDepth)) {
      if (stage.depth === 'surface') continue;
      if (this.closing || this.connectionState !== 'connected') return;
      await this.sync(stage.depth);
    }
  }

  /* ------------------------------ liveness ------------------------------- */

  private startProbing(): void {
    this.stopProbing();
    this.missed = 0;
    this.probeTimer = setInterval(() => {
      void this.probe();
    }, this.options.probeIntervalMs);
    this.probeTimer.unref?.();
  }

  private stopProbing(): void {
    if (!this.probeTimer) return;
    clearInterval(this.probeTimer);
    this.probeTimer = undefined;
  }

  /** One liveness check. Exposed for tests. */
  async probe(): Promise<boolean> {
    if (this.connectionState !== 'connected' || this.closing) return false;
    try {
      await this.client.get('/xinfo', {
        timeoutMs: this.options.probeTimeoutMs,
        priority: OscPriority.Housekeeping,
      });
      this.missed = 0;
      return true;
    } catch {
      this.missed += 1;
      this.logger.warn(
        `probe missed (${this.missed}/${this.options.maxMissedProbes})`,
      );
      if (this.missed >= this.options.maxMissedProbes) this.onLinkLost();
      return false;
    }
  }

  private onLinkLost(): void {
    if (this.connectionState === 'reconnecting' || this.closing) return;
    this.logger.error('link lost — reconnecting');
    this.stopProbing();
    this.heartbeat.unregister(this.id);
    this.setState('reconnecting');
    this.backoff.reset();
    this.reconnectLoop = this.reconnectUntilBack();
  }

  /** Resolves when the link is back. Exposed for tests. */
  get reconnecting(): Promise<void> | undefined {
    return this.reconnectLoop;
  }

  private async reconnectUntilBack(): Promise<void> {
    while (this.connectionState === 'reconnecting' && !this.closing) {
      const delay = this.backoff.next();
      await sleep(delay);
      if (this.closing || this.connectionState !== 'reconnecting') return;

      try {
        this.consoleInfo = await this.identify();
      } catch {
        continue;
      }

      this.logger.log(`reconnected after ${this.backoff.attempt} attempt(s)`);
      // The feed was dead while we were away, so the mirror is stale: take the
      // surface again before declaring the link usable.
      this.heartbeat.register(this.client);
      this.setState('syncing');
      await this.sync('surface');
      this.setState('connected');
      this.backoff.reset();
      this.startProbing();
      this.deepSync = this.runDeepSync();
      return;
    }
  }

  private setState(next: ConnectionState): void {
    if (next === this.connectionState) return;
    const previous = this.connectionState;
    this.connectionState = next;
    for (const listener of this.listeners) listener(next, previous);
  }
}
