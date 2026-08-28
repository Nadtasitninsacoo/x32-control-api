import { createSocket, RemoteInfo, Socket } from 'node:dgram';
import {
  decodeMessages,
  encodeMessage,
} from '../../src/osc/codec/osc-codec.js';
import {
  OscArg,
  OscMessage,
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
  stripRoots,
} from '../../src/osc/addresses/x32-addresses.js';
import {
  CHANNEL_COLORS,
  eqFreqToFloat,
  headampGainToFloat,
  levelFloatToDb,
  lowCutFreqToFloat,
} from '../../src/osc/units/x32-units.js';

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

  /* --------------------------- /node formatting --------------------------- */

  private formatNode(rawPath: string): string {
    const path = rawPath.startsWith('/') ? rawPath.slice(1) : rawPath;
    const address = `/${path}`;

    const leaf = this.state.get(address);
    if (leaf)
      return `${address} ${leaf.map((a) => formatNodeValue(address, a)).join(' ')}`;

    const prefix = `${address}/`;
    const children: string[] = [];
    for (const [childAddress, args] of this.state) {
      if (!childAddress.startsWith(prefix)) continue;
      if (childAddress.slice(prefix.length).includes('/')) continue; // one level only
      children.push(
        args.map((a) => formatNodeValue(childAddress, a)).join(' '),
      );
    }
    return `${address}${children.length ? ` ${children.join(' ')}` : ''}`;
  }

  /* ------------------------------ initial state --------------------------- */

  private seedDefaults(): void {
    const set = (address: string, args: OscArg[]): void => {
      this.state.set(address, args);
    };

    for (const root of allStripRoots()) {
      const isDca = root.startsWith('/dca/');
      set(`${root}/config/name`, [oscString('')]);
      set(`${root}/config/icon`, [oscInt(1)]);
      set(`${root}/config/color`, [oscInt(CHANNEL_COLORS.indexOf('WH'))]);

      const levelPrefix = isDca ? root : `${root}/mix`;
      set(`${levelPrefix}/on`, [oscInt(1)]);
      set(`${levelPrefix}/fader`, [oscFloat(0)]);
      if (isDca) continue;

      set(`${root}/mix/st`, [oscInt(1)]);
      set(`${root}/mix/pan`, [oscFloat(0.5)]);
      set(`${root}/mix/mono`, [oscInt(0)]);
      set(`${root}/mix/mlevel`, [oscFloat(0)]);

      // Bus sends exist on input-side strips only.
      if (/^\/(ch|auxin|fxrtn)\//.test(root)) {
        for (let bus = 1; bus <= STRIP_COUNTS.bus; bus += 1) {
          set(`${root}/mix/${pad2(bus)}/on`, [oscInt(1)]);
          set(`${root}/mix/${pad2(bus)}/level`, [oscFloat(0)]);
          set(`${root}/mix/${pad2(bus)}/pan`, [oscFloat(0.5)]);
        }
        this.seedProcessing(root, set);
      }
    }

    for (const root of stripRoots('bus').concat(stripRoots('mtx'), [
      '/main/st',
      '/main/m',
    ])) {
      this.seedProcessing(root, set);
    }

    // Local head amps 1..32.
    for (let input = 1; input <= 32; input += 1) {
      set(`${headampRoot(input)}/gain`, [oscFloat(headampGainToFloat(0))]);
      set(`${headampRoot(input)}/phantom`, [oscInt(0)]);
    }

    set('/config/mute/1', [oscInt(0)]);
    set('/-stat/xremotenfb', [oscInt(0)]);
  }

  private seedProcessing(
    root: string,
    set: (address: string, args: OscArg[]) => void,
  ): void {
    set(`${root}/preamp/trim`, [oscFloat(0.5)]);
    set(`${root}/preamp/invert`, [oscInt(0)]);
    set(`${root}/preamp/hpon`, [oscInt(0)]);
    set(`${root}/preamp/hpf`, [oscFloat(lowCutFreqToFloat(100))]);

    set(`${root}/gate/on`, [oscInt(0)]);
    set(`${root}/gate/mode`, [oscInt(0)]);
    set(`${root}/gate/thr`, [oscFloat(0.5)]);
    set(`${root}/gate/range`, [oscFloat(0.5)]);
    set(`${root}/gate/attack`, [oscFloat(0.1)]);
    set(`${root}/gate/hold`, [oscFloat(0.5)]);
    set(`${root}/gate/release`, [oscFloat(0.3)]);

    set(`${root}/dyn/on`, [oscInt(0)]);
    set(`${root}/dyn/mode`, [oscInt(0)]);
    set(`${root}/dyn/thr`, [oscFloat(0.5)]);
    set(`${root}/dyn/ratio`, [oscInt(3)]);
    set(`${root}/dyn/knee`, [oscFloat(0.5)]);
    set(`${root}/dyn/mgain`, [oscFloat(0)]);
    set(`${root}/dyn/attack`, [oscFloat(0.1)]);
    set(`${root}/dyn/hold`, [oscFloat(0.5)]);
    set(`${root}/dyn/release`, [oscFloat(0.3)]);
    set(`${root}/dyn/mix`, [oscFloat(1)]);

    set(`${root}/eq/on`, [oscInt(1)]);
    const bandDefaults = [100, 500, 2000, 8000];
    bandDefaults.forEach((hz, index) => {
      const band = index + 1;
      set(`${root}/eq/${band}/type`, [oscInt(3)]);
      set(`${root}/eq/${band}/f`, [oscFloat(eqFreqToFloat(hz))]);
      set(`${root}/eq/${band}/g`, [oscFloat(0.5)]);
      set(`${root}/eq/${band}/q`, [oscFloat(0.5)]);
    });
  }
}

/** `/node` dumps use the console's *display* units, not raw floats. */
export function formatNodeValue(address: string, arg: OscArg): string {
  if (arg.type === 's') return `"${arg.value}"`;
  if (arg.type === 'b') return `<blob>`;

  if (
    address.endsWith('/on') ||
    address.endsWith('/st') ||
    address.endsWith('/mono')
  ) {
    return arg.value >= 1 ? 'ON' : 'OFF';
  }
  if (address.endsWith('/color')) {
    return CHANNEL_COLORS[
      Math.max(0, Math.min(CHANNEL_COLORS.length - 1, Math.round(arg.value)))
    ];
  }
  if (
    address.endsWith('/fader') ||
    address.endsWith('/level') ||
    address.endsWith('/mlevel')
  ) {
    const db = levelFloatToDb(arg.value);
    return db <= -90 ? '-oo' : db.toFixed(1);
  }
  if (arg.type === 'i') return String(arg.value);
  return arg.value.toFixed(6);
}
