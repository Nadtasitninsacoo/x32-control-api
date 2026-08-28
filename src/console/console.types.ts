import { OscEndpoint } from '../osc/transport/osc-transport.js';

export type ConnectionState =
  /** No socket, nothing scheduled. */
  | 'disconnected'
  /** First contact in progress. */
  | 'connecting'
  /** Reachable; the surface of the state mirror is being filled. */
  | 'syncing'
  /** Usable. Deep sync may still be running in the background. */
  | 'connected'
  /** Was connected, lost contact, retrying with backoff. */
  | 'reconnecting';

export interface ConsoleInfo {
  readonly host: string;
  readonly port: number;
  /** OSC server version reported by `/info`. */
  readonly serverVersion: string;
  readonly name: string;
  /** `X32`, `X32C`, `M32`, … */
  readonly model: string;
  readonly firmware: string;
}

export interface DiscoveredConsole extends ConsoleInfo {
  /** Round-trip time of the discovery probe, in milliseconds. */
  readonly rttMs: number;
}

/** How much of the console to mirror at connect time. */
export type SyncDepth =
  /** Names, colours, faders, mutes — everything a surface view needs. */
  | 'surface'
  /** …plus every bus send. */
  | 'sends'
  /** …plus preamp, gate, dynamics and EQ. */
  | 'full';

export interface SyncReport {
  readonly depth: SyncDepth;
  readonly queries: number;
  readonly applied: number;
  /** Containers whose dump did not match the schema and were read one by one. */
  readonly unparsed: readonly string[];
  readonly fallbackReads: number;
  readonly failed: number;
  readonly durationMs: number;
}

export interface ConsoleStatus {
  readonly id: string;
  readonly state: ConnectionState;
  readonly endpoint: OscEndpoint;
  readonly info: ConsoleInfo | undefined;
  readonly cachedAddresses: number;
  readonly lastSyncAt: number | undefined;
  readonly lastFeedAt: number | undefined;
  readonly missedProbes: number;
  readonly reconnectAttempts: number;
  readonly dryRun: boolean;
}
