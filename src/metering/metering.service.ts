import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EnvVars } from '../config/env.validation.js';
import { ConsoleManagerService } from '../console/console-manager.service.js';
import { ConsoleConnection } from '../console/connection/console-connection.js';
import { message } from '../osc/codec/osc-codec.js';
import { oscInt, oscString } from '../osc/codec/osc-types.js';
import { OscPriority } from '../osc/rate-limit/osc-rate-limiter.js';
import {
  BANK_CHANNELS,
  BANK_MAINS,
  CHANNEL_SEGMENT,
  MAIN_SEGMENT,
  MeterBank,
  SUBSCRIBED_BANKS,
  segmentOf,
} from './meter-banks.js';
import { SILENCE_DBFS, decodeMeterMessage } from './meter-decoder.js';

export interface MeterFrame {
  readonly consoleId: string;
  /** Epoch ms at which this frame was assembled. */
  readonly at: number;
  /** dBFS for input channels 1-32, in order. */
  readonly channels: number[];
  readonly mains: { left: number; right: number; mono: number };
}

export type MeterFrameListener = (frame: MeterFrame) => void;

/**
 * Meter streaming.
 *
 * Two things shape this service. First, meter subscriptions expire after ten
 * seconds like everything else on this console, so they are renewed on a timer;
 * `/unsubscribe` is deliberately never sent, because on the X32 it drops *every*
 * subscription for the socket — including the `/xremote` parameter feed the
 * whole state mirror depends on. Letting a subscription lapse is the safe way
 * to stop it.
 *
 * Second, meters arrive far faster than any UI can use. Frames are coalesced:
 * the newest values are kept and published on a fixed 20 fps tick, so a slow
 * client sees current meters rather than a backlog of stale ones.
 *
 * The console is only asked for meters while somebody is listening.
 */
@Injectable()
export class MeteringService implements OnModuleDestroy {
  private readonly logger = new Logger(MeteringService.name);
  private readonly streams = new Map<string, MeterStream>();

  constructor(
    private readonly consoles: ConsoleManagerService,
    private readonly config: ConfigService<EnvVars, true>,
  ) {}

  onModuleDestroy(): void {
    for (const stream of this.streams.values()) stream.stop();
    this.streams.clear();
  }

  get frameIntervalMs(): number {
    return Math.round(1000 / this.config.get('METER_FPS', { infer: true }));
  }

  /**
   * Starts (or joins) the meter stream for a console.
   * @returns a release function; the console stops being asked for meters once
   *          the last listener releases.
   */
  listen(consoleId: string, listener: MeterFrameListener): () => void {
    const connection = this.consoles.require(consoleId);
    let stream = this.streams.get(consoleId);

    if (!stream) {
      stream = new MeterStream(
        connection,
        {
          frameIntervalMs: this.frameIntervalMs,
          renewMs: this.config.get('METER_RENEW_MS', { infer: true }),
          timeFactor: this.config.get('METER_TIME_FACTOR', { infer: true }),
        },
        this.logger,
      );
      this.streams.set(consoleId, stream);
      stream.start();
    }

    const release = stream.addListener(listener);
    return () => {
      release();
      const current = this.streams.get(consoleId);
      if (current && current.listenerCount === 0) {
        current.stop();
        this.streams.delete(consoleId);
      }
    };
  }

  /** The most recent frame, if this console is being metered right now. */
  latest(consoleId: string): MeterFrame | undefined {
    return this.streams.get(consoleId)?.latestFrame;
  }

  get activeConsoleIds(): string[] {
    return [...this.streams.keys()];
  }

  /**
   * Reads one bank as raw dBFS values, without subscribing.
   *
   * This is the tool for pinning down which slot is which on real hardware:
   * send signal into one input and watch which index moves.
   */
  async readRawBank(consoleId: string, address: string): Promise<number[]> {
    const connection = this.consoles.require(consoleId);
    const reply = await connection.osc.get(address, {
      priority: OscPriority.Polling,
    });
    return decodeMeterMessage(reply) ?? [];
  }
}

interface StreamOptions {
  readonly frameIntervalMs: number;
  readonly renewMs: number;
  readonly timeFactor: number;
}

/** One console's meter subscription, coalescing and publication. */
class MeterStream {
  private readonly listeners = new Set<MeterFrameListener>();
  private readonly values = new Map<string, number[]>();

  private detach: (() => void) | undefined;
  private renewTimer: NodeJS.Timeout | undefined;
  private frameTimer: NodeJS.Timeout | undefined;
  private dirty = false;

  latestFrame: MeterFrame | undefined;

  constructor(
    private readonly connection: ConsoleConnection,
    private readonly options: StreamOptions,
    private readonly logger: Logger,
  ) {}

  get listenerCount(): number {
    return this.listeners.size;
  }

  addListener(listener: MeterFrameListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  start(): void {
    this.detach = this.connection.osc.onMessage((msg) => {
      if (!msg.address.startsWith('/meters/')) return;
      const values = safeDecode(msg, this.logger);
      if (!values) return;
      this.values.set(msg.address, values);
      this.dirty = true;
    });

    this.subscribeAll();
    this.renewTimer = setInterval(
      () => this.subscribeAll(),
      this.options.renewMs,
    );
    this.renewTimer.unref?.();

    this.frameTimer = setInterval(
      () => this.publish(),
      this.options.frameIntervalMs,
    );
    this.frameTimer.unref?.();

    this.logger.log(
      `metering ${this.connection.id}: ${SUBSCRIBED_BANKS.map((b) => b.address).join(', ')} ` +
        `at ${Math.round(1000 / this.options.frameIntervalMs)} fps`,
    );
  }

  stop(): void {
    this.detach?.();
    this.detach = undefined;
    if (this.renewTimer) clearInterval(this.renewTimer);
    if (this.frameTimer) clearInterval(this.frameTimer);
    this.renewTimer = undefined;
    this.frameTimer = undefined;
    this.listeners.clear();
    // No /unsubscribe: it would take the /xremote feed down with it. The
    // console forgets us within its own subscription lifetime instead.
    this.logger.log(
      `metering ${this.connection.id}: stopped, subscription left to lapse`,
    );
  }

  private subscribeAll(): void {
    if (!this.connection.osc.isOpen) return;
    for (const bank of SUBSCRIBED_BANKS) {
      void this.connection.osc
        .send(
          message(
            '/subscribe',
            oscString(bank.address),
            oscInt(this.options.timeFactor),
          ),
          OscPriority.Housekeeping,
        )
        .catch(() => undefined);
      void this.connection.osc
        .send(
          message('/renew', oscString(bank.address)),
          OscPriority.Housekeeping,
        )
        .catch(() => undefined);
    }
  }

  private publish(): void {
    if (!this.dirty || this.listeners.size === 0) return;
    this.dirty = false;

    const frame: MeterFrame = {
      consoleId: this.connection.id,
      at: Date.now(),
      channels: this.segment(
        CHANNEL_SEGMENT.bank,
        CHANNEL_SEGMENT.offset,
        CHANNEL_SEGMENT.length,
      ),
      mains: (() => {
        const [left = SILENCE_DBFS, right = SILENCE_DBFS, mono = SILENCE_DBFS] =
          this.segment(
            MAIN_SEGMENT.bank,
            MAIN_SEGMENT.offset,
            MAIN_SEGMENT.length,
          );
        return { left, right, mono };
      })(),
    };

    this.latestFrame = frame;
    for (const listener of this.listeners) {
      try {
        listener(frame);
      } catch (error) {
        this.logger.warn(
          `meter listener threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private segment(bank: MeterBank, offset: number, length: number): number[] {
    const values = this.values.get(bank.address);
    if (!values) return Array.from({ length }, () => SILENCE_DBFS);
    const slice = segmentOf(values, offset, length);
    while (slice.length < length) slice.push(SILENCE_DBFS);
    return slice;
  }
}

function safeDecode(
  msg: Parameters<typeof decodeMeterMessage>[0],
  logger: Logger,
): number[] | undefined {
  try {
    return decodeMeterMessage(msg);
  } catch (error) {
    logger.warn(
      `dropped a malformed meter blob on ${msg.address}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return undefined;
  }
}

export { BANK_CHANNELS, BANK_MAINS };
