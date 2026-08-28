import { createSocket, RemoteInfo, Socket } from 'node:dgram';
import {
  decodeMessages,
  encodeMessage,
} from '../../src/osc/codec/osc-codec.js';
import {
  OscArg,
  OscMessage,
  argAsNumber,
  argAsString,
  oscFloat,
  oscInt,
  oscString,
} from '../../src/osc/codec/osc-types.js';
import {
  STRIP_COUNTS,
  allStripRoots,
  headampRoot,
  pad2,
} from '../../src/osc/addresses/x32-addresses.js';
import {
  CHANNEL_COLORS,
  eqFreqToFloat,
  headampGainToFloat,
  lowCutFreqToFloat,
} from '../../src/osc/units/x32-units.js';
import {
  containerFor,
  formatNodeToken,
  paramFor,
} from '../../src/osc/schema/x32-schema.js';
import {
  StripCapabilities,
  capabilitiesFor,
  familyOf,
} from '../../src/osc/schema/x32-capabilities.js';

/**
 * A UDP stand-in for an X32/M32 console.
 *
 * Faithful where it matters for this codebase:
 *  - replies carry the *same address* as the query (`/node` answers on the
 *    bare address `node`, exactly like the real console);
 *  - `/xremote` subscriptions expire after 10s and must be renewed;
 *  - meter blobs are little-endian *inside* the blob, while the surrounding
 *    OSC framing is big-endian — the console's best-known gotcha;
 *  - `/node` dumps use display units (dB, ON/OFF), not raw floats.
 *
 * Deliberately not modelled: routing matrices, effects racks, USB recorder,
 * show/cue file contents beyond a name list. Fault injection (packet loss,
 * added latency) is available so reconnect and rate-limit behaviour can be
 * exercised without unplugging a cable.
 */

export interface X32EmulatorOptions {
  /** 0 (default) binds an ephemeral port; pass 10023 to imitate the console. */
  readonly port?: number;
  readonly address?: string;
  readonly serverVersion?: string;
  readonly name?: string;
  readonly model?: string;
  readonly firmware?: string;
  /** Fraction of *inbound* datagrams to silently discard, 0..1. */
  readonly dropRate?: number;
  /** Artificial delay before each reply, in milliseconds. */
  readonly latencyMs?: number;
  /** Lifetime of an /xremote or meter subscription. Real console: 10000. */
  readonly subscriptionTtlMs?: number;
  /** Meter push period while subscribed. Real console: 50ms at factor 1. */
  readonly meterIntervalMs?: number;
  /** Deterministic seed for meter values. */
  readonly seed?: number;
}

export interface MeterLayout {
  readonly address: string;
  readonly count: number;
}

/**
 * Meter banks. Counts follow the X32 OSC protocol notes; the two this project
 * uses are `/meters/1` (input channels) and `/meters/13` (main/matrix).
 */
export const METER_LAYOUTS: readonly MeterLayout[] = [
  { address: '/meters/0', count: 70 },
  { address: '/meters/1', count: 96 },
  { address: '/meters/2', count: 49 },
  { address: '/meters/13', count: 24 },
];

interface Subscriber {
  readonly key: string;
  readonly host: string;
  readonly port: number;
  expiresAt: number;
}

interface MeterSubscriber extends Subscriber {
  /** Address the blob is published on — the alias for /batchsubscribe. */
  readonly replyAddress: string;
  readonly layout: MeterLayout;
}

const DEFAULT_OPTIONS = {
  port: 0,
  address: '127.0.0.1',
  serverVersion: 'V2.07',
  name: 'X32-EMULATOR',
  model: 'X32',
  firmware: '4.06',
  dropRate: 0,
  latencyMs: 0,
  subscriptionTtlMs: 10_000,
  meterIntervalMs: 50,
  seed: 1,
} satisfies Required<X32EmulatorOptions>;

export class X32Emulator {
  private readonly options: Required<X32EmulatorOptions>;
  private socket: Socket | undefined;
  private boundPort = 0;

  private readonly state = new Map<string, OscArg[]>();
  /** Saved scenes: the console's show file, as far as this emulator models it. */
  private readonly scenes = new Map<number, Map<string, OscArg[]>>();
  private readonly xremote = new Map<string, Subscriber>();
  private readonly meterSubs = new Map<string, MeterSubscriber>();
  private meterTimer: NodeJS.Timeout | undefined;
  private tick = 0;
  private rngState = 0;

  /** Every decoded inbound message, in arrival order — for assertions. */
  readonly received: OscMessage[] = [];

  constructor(options: X32EmulatorOptions = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.resetState();
  }

  get port(): number {
    return this.boundPort;
  }

  get host(): string {
    return this.options.address;
  }

  get xremoteSubscriberCount(): number {
    this.expireSubscriptions();
    return this.xremote.size;
  }

  get meterSubscriberCount(): number {
    this.expireSubscriptions();
    return this.meterSubs.size;
  }

  /** Messages received on a given address (handy for asserting pacing). */
  receivedOn(address: string): OscMessage[] {
    return this.received.filter((m) => m.address === address);
  }

  async start(): Promise<number> {
    if (this.socket) return this.boundPort;
    const socket = createSocket({ type: 'udp4', reuseAddr: true });
    socket.on('message', (data, from) => this.handleDatagram(data, from));
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(this.options.port, this.options.address, () => resolve());
    });
    socket.setBroadcast(true);
    this.socket = socket;
    this.boundPort = socket.address().port;
    this.meterTimer = setInterval(
      () => this.pushMeters(),
      this.options.meterIntervalMs,
    );
    this.meterTimer.unref?.();
    return this.boundPort;
  }

  async stop(): Promise<void> {
    if (this.meterTimer) {
      clearInterval(this.meterTimer);
      this.meterTimer = undefined;
    }
    const socket = this.socket;
    this.socket = undefined;
    this.xremote.clear();
    this.meterSubs.clear();
    if (!socket) return;
    await new Promise<void>((resolve) => socket.close(() => resolve()));
  }

  /** Current raw value of a parameter, as the console holds it. */
  get(address: string): OscArg[] | undefined {
    return this.state.get(address);
  }

  /** Console-side change (someone touched a physical fader): pushes to feed. */
  setFromConsole(address: string, args: OscArg[]): void {
    this.state.set(address, args);
    this.publish({ address, args });
  }

  /** Forget every subscriber without closing the socket — simulates a reboot. */
  dropSubscriptions(): void {
    this.xremote.clear();
    this.meterSubs.clear();
  }

  resetState(): void {
    this.state.clear();
    this.seedDefaults();
  }

  /* ------------------------------- internals ------------------------------ */

  private handleDatagram(data: Buffer, from: RemoteInfo): void {
    if (this.options.dropRate > 0 && this.random() < this.options.dropRate)
      return;

    let messages: OscMessage[];
    try {
      messages = decodeMessages(data);
    } catch {
      return; // a real console ignores garbage too
    }

    for (const msg of messages) {
      this.received.push(msg);
      this.handleMessage(msg, from);
    }
  }

  private handleMessage(msg: OscMessage, from: RemoteInfo): void {
    const { address, args } = msg;

    switch (address) {
      case '/info':
        this.reply(from, {
          address: '/info',
          args: [
            oscString(this.options.serverVersion),
            oscString(this.options.name),
            oscString(this.options.model),
            oscString(this.options.firmware),
          ],
        });
        return;

      case '/xinfo':
        this.reply(from, {
          address: '/xinfo',
          args: [
            oscString(this.options.address),
            oscString(this.options.name),
            oscString(this.options.model),
            oscString(this.options.firmware),
          ],
        });
        return;

      case '/save': {
        // /save ,s "scene" ,i index ,s name ,s note
        const what = argAsString(args[0]);
        const index = argAsNumber(args[1]);
        if (what !== 'scene' || index === undefined) return;
        this.saveScene(
          index,
          argAsString(args[2]) ?? '',
          argAsString(args[3]) ?? '',
        );
        return;
      }

      case '/-action/goscene': {
        const index = argAsNumber(args[0]);
        if (index !== undefined) this.recallScene(index);
        return;
      }

      case '/-action/gocue':
      case '/-action/gosnippet': {
        const index = argAsNumber(args[0]);
        if (index !== undefined) {
          this.state.set('/-show/prepos/current', [oscInt(index)]);
        }
        return;
      }

      case '/status':
        this.reply(from, {
          address: '/status',
          args: [
            oscString('active'),
            oscString(this.options.address),
            oscString(this.options.name),
          ],
        });
        return;

      case '/xremote':
        this.subscribeXRemote(from);
        return;

      case '/unsubscribe':
        this.unsubscribe(from);
        return;

      case '/renew':
        this.renew(from, argAsString(args[0]));
        return;

      case '/node': {
        const path = argAsString(args[0]);
        if (path === undefined) return;
        // The console answers a /node query on the bare address "node".
        this.reply(from, {
          address: 'node',
          args: [oscString(this.formatNode(path))],
        });
        return;
      }

      case '/subscribe': {
        const path = argAsString(args[0]);
        if (path) this.subscribeMeters(from, path, path);
        return;
      }

      case '/batchsubscribe': {
        const alias = argAsString(args[0]);
        const path = argAsString(args[1]);
        if (alias && path) this.subscribeMeters(from, path, alias);
        return;
      }

      default:
        break;
    }

    const meterLayout = METER_LAYOUTS.find((l) => l.address === address);
    if (meterLayout && args.length === 0) {
      this.reply(from, {
        address,
        args: [{ type: 'b', value: this.meterBlob(meterLayout) }],
      });
      return;
    }

    if (args.length === 0) {
      // Query: reply with the stored value, or stay silent for an address the
      // console does not know — exactly like the hardware.
      const stored = this.state.get(address);
      if (stored) this.reply(from, { address, args: stored });
      return;
    }

    if (!this.state.has(address)) return; // unknown parameter: ignored
    this.state.set(address, [...args]);
    this.publish({ address, args });
  }

  private subscribeXRemote(from: RemoteInfo): void {
    const key = `${from.address}:${from.port}`;
    this.xremote.set(key, {
      key,
      host: from.address,
      port: from.port,
      expiresAt: Date.now() + this.options.subscriptionTtlMs,
    });
  }

  private subscribeMeters(
    from: RemoteInfo,
    path: string,
    replyAddress: string,
  ): void {
    const layout = METER_LAYOUTS.find((l) => l.address === path);
    if (!layout) return;
    const key = `${from.address}:${from.port}:${replyAddress}`;
    this.meterSubs.set(key, {
      key,
      host: from.address,
      port: from.port,
      replyAddress,
      layout,
      expiresAt: Date.now() + this.options.subscriptionTtlMs,
    });
  }

  private unsubscribe(from: RemoteInfo): void {
    const prefix = `${from.address}:${from.port}`;
    this.xremote.delete(prefix);
    // Deleting the current entry while iterating a Map is well defined.
    for (const key of this.meterSubs.keys()) {
      if (key.startsWith(`${prefix}:`)) this.meterSubs.delete(key);
    }
  }

  private renew(from: RemoteInfo, alias: string | undefined): void {
    const expiresAt = Date.now() + this.options.subscriptionTtlMs;
    const prefix = `${from.address}:${from.port}`;
    const xremote = this.xremote.get(prefix);
    if (xremote) xremote.expiresAt = expiresAt;
    for (const [key, sub] of this.meterSubs) {
      if (!key.startsWith(`${prefix}:`)) continue;
      if (
        alias === undefined ||
        sub.replyAddress === alias ||
        sub.layout.address === alias
      ) {
        sub.expiresAt = expiresAt;
      }
    }
  }

  private expireSubscriptions(): void {
    const now = Date.now();
    for (const [key, sub] of this.xremote)
      if (sub.expiresAt <= now) this.xremote.delete(key);
    for (const [key, sub] of this.meterSubs)
      if (sub.expiresAt <= now) this.meterSubs.delete(key);
  }

  /** Pushes a parameter change to every live /xremote subscriber. */
  private publish(msg: OscMessage): void {
    this.expireSubscriptions();
    for (const sub of this.xremote.values()) {
      this.sendTo(sub.host, sub.port, msg);
    }
  }

  private pushMeters(): void {
    this.expireSubscriptions();
    this.tick += 1;
    for (const sub of this.meterSubs.values()) {
      this.sendTo(sub.host, sub.port, {
        address: sub.replyAddress,
        args: [{ type: 'b', value: this.meterBlob(sub.layout) }],
      });
    }
  }

  /**
   * Meter blob: int32 sample count followed by that many float32 values —
   * all little-endian, unlike the big-endian OSC framing around them.
   */
  private meterBlob(layout: MeterLayout): Buffer {
    const buf = Buffer.alloc(4 + layout.count * 4);
    buf.writeInt32LE(layout.count, 0);
    for (let i = 0; i < layout.count; i += 1) {
      const phase = (this.tick / 20 + i / 7) % 1;
      // A slow sweep between silence and -3 dBFS, deterministic per tick.
      const value = 0.05 + 0.65 * (0.5 - 0.5 * Math.cos(2 * Math.PI * phase));
      buf.writeFloatLE(value, 4 + i * 4);
    }
    return buf;
  }

  private reply(to: RemoteInfo, msg: OscMessage): void {
    this.sendTo(to.address, to.port, msg);
  }

  private sendTo(host: string, port: number, msg: OscMessage): void {
    const socket = this.socket;
    if (!socket) return;
    const payload = encodeMessage(msg);
    const deliver = (): void => {
      if (this.socket) socket.send(payload, port, host, () => undefined);
    };
    if (this.options.latencyMs > 0)
      setTimeout(deliver, this.options.latencyMs).unref?.();
    else deliver();
  }

  private random(): number {
    // xorshift: deterministic given the seed, so a "lossy network" test is
    // reproducible in CI.
    let x = (this.rngState += 1) ^ this.options.seed;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return Math.abs(x % 10_000) / 10_000;
  }

  /* ------------------------------- show file ------------------------------ */

  /** Snapshots every parameter into a scene slot, as the console would. */
  private saveScene(index: number, name: string, note: string): void {
    const snapshot = new Map<string, OscArg[]>();
    for (const [address, args] of this.state) {
      if (address.startsWith('/-show/')) continue;
      snapshot.set(address, [...args]);
    }
    this.scenes.set(index, snapshot);
    const slot = `/-show/showfile/scene/${String(index).padStart(3, '0')}`;
    this.state.set(`${slot}/name`, [oscString(name)]);
    this.state.set(`${slot}/notes`, [oscString(note)]);
  }

  /** Restores a scene and pushes every changed value to the feed. */
  private recallScene(index: number): void {
    const snapshot = this.scenes.get(index);
    this.state.set('/-show/prepos/current', [oscInt(index)]);
    if (!snapshot) return;

    for (const [address, args] of snapshot) {
      const current = this.state.get(address);
      this.state.set(address, [...args]);
      if (!current || !sameArgs(current, args)) this.publish({ address, args });
    }
  }

  /* --------------------------- /node formatting --------------------------- */

  private formatNode(rawPath: string): string {
    const path = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
    const address = `/${path}`;

    // A leaf query prints the single value.
    const leaf = paramFor(address);
    const stored = this.state.get(address);
    if (leaf && stored && stored.length > 0) {
      return `${address} ${formatNodeToken(leaf, stored[0])}`;
    }

    // A container prints its children in schema order, in display units.
    const container = containerFor(address);
    if (container) {
      const tokens: string[] = [];
      for (const child of container.children) {
        const args = this.state.get(`${address}/${child.name}`);
        if (!args || args.length === 0) return address; // node this model lacks
        tokens.push(formatNodeToken(child, args[0]));
      }
      return `${address} ${tokens.join(' ')}`;
    }

    return address;
  }

  /* ------------------------------ initial state --------------------------- */

  private seedDefaults(): void {
    const set = (address: string, args: OscArg[]): void => {
      this.state.set(address, args);
    };

    for (const root of allStripRoots()) {
      const family = familyOf(root);
      if (!family) continue;
      const caps = capabilitiesFor(family);

      if (caps.config) {
        set(`${root}/config/name`, [oscString('')]);
        set(`${root}/config/icon`, [oscInt(1)]);
        set(`${root}/config/color`, [oscInt(CHANNEL_COLORS.indexOf('WH'))]);
        if (caps.source) set(`${root}/config/source`, [oscInt(0)]);
      }

      // A DCA's fader and mute sit on the root; every other strip has /mix.
      const mixRoot = caps.mix ? `${root}/mix` : root;
      set(`${mixRoot}/on`, [oscInt(1)]);
      set(`${mixRoot}/fader`, [oscFloat(0)]);
      if (caps.mix) {
        set(`${root}/mix/st`, [oscInt(1)]);
        set(`${root}/mix/pan`, [oscFloat(0.5)]);
        set(`${root}/mix/mono`, [oscInt(0)]);
        set(`${root}/mix/mlevel`, [oscFloat(0)]);
      }

      for (let send = 1; send <= caps.sends; send += 1) {
        set(`${root}/mix/${pad2(send)}/on`, [oscInt(1)]);
        set(`${root}/mix/${pad2(send)}/level`, [oscFloat(0)]);
        set(`${root}/mix/${pad2(send)}/pan`, [oscFloat(0.5)]);
      }

      this.seedProcessing(root, caps, set);
    }

    // Local head amps 1..32.
    for (let input = 1; input <= STRIP_COUNTS.ch; input += 1) {
      set(`${headampRoot(input)}/gain`, [oscFloat(headampGainToFloat(0))]);
      set(`${headampRoot(input)}/phantom`, [oscInt(0)]);
    }

    // Show file slots. A real console answers with an empty name for a slot
    // that has never been used, rather than staying silent.
    for (const kind of ['scene', 'cue', 'snippet'] as const) {
      for (let index = 0; index < 100; index += 1) {
        const slot = `/-show/showfile/${kind}/${String(index).padStart(3, '0')}`;
        set(`${slot}/name`, [oscString('')]);
        if (kind === 'scene') set(`${slot}/notes`, [oscString('')]);
      }
    }
    set('/-show/prepos/current', [oscInt(0)]);

    set('/config/mute/1', [oscInt(0)]);
    set('/-stat/xremotenfb', [oscInt(0)]);
  }

  private seedProcessing(
    root: string,
    caps: StripCapabilities,
    set: (address: string, args: OscArg[]) => void,
  ): void {
    if (caps.preamp) {
      set(`${root}/preamp/trim`, [oscFloat(0.5)]);
      set(`${root}/preamp/invert`, [oscInt(0)]);
      set(`${root}/preamp/hpon`, [oscInt(0)]);
      set(`${root}/preamp/hpf`, [oscFloat(lowCutFreqToFloat(100))]);
    }

    if (caps.gate) {
      set(`${root}/gate/on`, [oscInt(0)]);
      set(`${root}/gate/mode`, [oscInt(0)]);
      set(`${root}/gate/thr`, [oscFloat(0.5)]);
      set(`${root}/gate/range`, [oscFloat(0.5)]);
      set(`${root}/gate/attack`, [oscFloat(0.1)]);
      set(`${root}/gate/hold`, [oscFloat(0.5)]);
      set(`${root}/gate/release`, [oscFloat(0.3)]);
      set(`${root}/gate/keysrc`, [oscInt(0)]);
    }

    if (caps.dyn) {
      set(`${root}/dyn/on`, [oscInt(0)]);
      set(`${root}/dyn/mode`, [oscInt(0)]);
      set(`${root}/dyn/det`, [oscInt(0)]);
      set(`${root}/dyn/env`, [oscInt(1)]);
      set(`${root}/dyn/thr`, [oscFloat(0.5)]);
      set(`${root}/dyn/ratio`, [oscInt(3)]);
      set(`${root}/dyn/knee`, [oscFloat(0.5)]);
      set(`${root}/dyn/mgain`, [oscFloat(0)]);
      set(`${root}/dyn/attack`, [oscFloat(0.1)]);
      set(`${root}/dyn/hold`, [oscFloat(0.5)]);
      set(`${root}/dyn/release`, [oscFloat(0.3)]);
      set(`${root}/dyn/pos`, [oscInt(1)]);
      set(`${root}/dyn/keysrc`, [oscInt(0)]);
      set(`${root}/dyn/mix`, [oscFloat(1)]);
    }

    if (caps.eqBands > 0) {
      set(`${root}/eq/on`, [oscInt(1)]);
      // Spread the default bands across the spectrum, as a fresh scene does.
      const defaults = [100, 250, 800, 2500, 6300, 12500];
      for (let band = 1; band <= caps.eqBands; band += 1) {
        set(`${root}/eq/${band}/type`, [oscInt(2)]);
        set(`${root}/eq/${band}/f`, [
          oscFloat(eqFreqToFloat(defaults[band - 1])),
        ]);
        set(`${root}/eq/${band}/g`, [oscFloat(0.5)]);
        set(`${root}/eq/${band}/q`, [oscFloat(0.5)]);
      }
    }
  }
}

function sameArgs(a: readonly OscArg[], b: readonly OscArg[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((arg, i) => {
    const other = b[i];
    if (arg.type !== other.type) return false;
    if (arg.type === 'b' && other.type === 'b')
      return arg.value.equals(other.value);
    return arg.value === other.value;
  });
}
