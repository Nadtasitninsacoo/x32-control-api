import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConsoleManagerService } from '../console/console-manager.service.js';
import { ConsoleConnection } from '../console/connection/console-connection.js';
import { headampRoot, pad2 } from '../osc/addresses/x32-addresses.js';
import { OscArg } from '../osc/codec/osc-types.js';
import { OscPriority } from '../osc/rate-limit/osc-rate-limiter.js';
import {
  HumanValue,
  containerFor,
  fromHuman,
  paramFor,
} from '../osc/schema/x32-schema.js';
import {
  DynamicsDto,
  EqBandDto,
  EqDto,
  GateDto,
  PreampDto,
  SendDto,
  StripConfigDto,
  StripDto,
  StripMixDto,
  StripSummaryDto,
} from './dto/strip.dto.js';
import { UpdateStripDto } from './dto/update-strip.dto.js';
import {
  StripRef,
  allStrips,
  headampIndexFor,
  resolveStrip,
} from './strip-ref.js';

/**
 * The mixer surface, in engineering units.
 *
 * Reads come from the state mirror rather than the console: the mirror is
 * current (the `/xremote` feed pushes every change, including moves made on
 * the physical surface) and a read costs nothing on the wire. Where the deep
 * sync has not reached a container yet, it is fetched once, on demand.
 *
 * Writes go straight out as OSC and are applied to the mirror optimistically;
 * the console's own echo confirms them a few milliseconds later.
 */

/** Maps an API field to the address suffix under the strip root. */
type FieldMap = Readonly<Record<string, string>>;

const CONFIG_FIELDS: FieldMap = {
  name: 'config/name',
  icon: 'config/icon',
  color: 'config/color',
  source: 'config/source',
};

const GATE_FIELDS: FieldMap = {
  on: 'gate/on',
  mode: 'gate/mode',
  thresholdDb: 'gate/thr',
  rangeDb: 'gate/range',
  attackMs: 'gate/attack',
  holdMs: 'gate/hold',
  releaseMs: 'gate/release',
};

const DYN_FIELDS: FieldMap = {
  on: 'dyn/on',
  mode: 'dyn/mode',
  detection: 'dyn/det',
  envelope: 'dyn/env',
  thresholdDb: 'dyn/thr',
  ratio: 'dyn/ratio',
  knee: 'dyn/knee',
  makeupGainDb: 'dyn/mgain',
  attackMs: 'dyn/attack',
  holdMs: 'dyn/hold',
  releaseMs: 'dyn/release',
  position: 'dyn/pos',
  mixPercent: 'dyn/mix',
};

const PREAMP_FIELDS: FieldMap = {
  trimDb: 'preamp/trim',
  invert: 'preamp/invert',
  lowCutOn: 'preamp/hpon',
  lowCutHz: 'preamp/hpf',
};

const EQ_BAND_FIELDS: FieldMap = {
  type: 'type',
  frequencyHz: 'f',
  gainDb: 'g',
  q: 'q',
};

@Injectable()
export class MixerService {
  private readonly logger = new Logger(MixerService.name);

  constructor(private readonly consoles: ConsoleManagerService) {}

  /* --------------------------------- reads -------------------------------- */

  async listStrips(consoleId: string): Promise<StripSummaryDto[]> {
    const connection = this.connection(consoleId);
    return allStrips().map((ref) => ({
      id: ref.id,
      kind: ref.family,
      index: ref.index,
      name: (this.read(connection, `${ref.root}/config/name`) as string) ?? '',
      color:
        (this.read(connection, `${ref.root}/config/color`) as string) ?? 'OFF',
      faderDb: (this.read(connection, this.faderAddress(ref)) as number) ?? -90,
      muted: this.read(connection, this.muteAddress(ref)) === false,
    }));
  }

  async getStrip(
    consoleId: string,
    kind: string,
    index: string,
  ): Promise<StripDto> {
    const connection = this.connection(consoleId);
    const ref = resolveStrip(kind, index);
    await this.ensureLoaded(connection, ref);

    const caps = ref.capabilities;
    const strip: StripDto = {
      id: ref.id,
      kind: ref.family,
      index: ref.index,
      oscRoot: ref.root,
      config: this.readConfig(connection, ref),
      mix: this.readMix(connection, ref),
    };

    if (caps.sends > 0) strip.sends = this.readSends(connection, ref);
    if (caps.preamp) strip.preamp = this.readPreamp(connection, ref);
    if (caps.gate) strip.gate = this.readGate(connection, ref);
    if (caps.dyn) strip.dynamics = this.readDynamics(connection, ref);
    if (caps.eqBands > 0) strip.eq = this.readEq(connection, ref);
    return strip;
  }

  /* --------------------------------- writes ------------------------------- */

  async updateStrip(
    consoleId: string,
    kind: string,
    index: string,
    update: UpdateStripDto,
  ): Promise<StripDto> {
    const connection = this.connection(consoleId);
    const ref = resolveStrip(kind, index);
    const writes = this.planWrites(ref, update);

    if (writes.length === 0) {
      throw new BadRequestException('the update contains no changes');
    }

    for (const write of writes) {
      await connection.osc.set(write.address, [write.arg], OscPriority.Command);
      // Optimistic: the console echoes the change back over /xremote within
      // milliseconds, which overwrites this with the authoritative value.
      connection.cache.set(write.address, [write.arg], 'local');
    }
    this.logger.log(
      `${consoleId} ${ref.id}: ${writes.length} parameter(s) updated`,
    );

    return this.getStrip(consoleId, kind, index);
  }

  /**
   * Turns an update into the exact list of OSC writes it implies.
   * Exposed so callers that need the diff (presets, audit) can see it first.
   */
  planWrites(
    ref: StripRef,
    update: UpdateStripDto,
  ): { address: string; arg: OscArg }[] {
    const writes: { address: string; arg: OscArg }[] = [];
    const caps = ref.capabilities;

    const push = (address: string, value: HumanValue): void => {
      const def = paramFor(address);
      if (!def)
        throw new BadRequestException(`no such console parameter: ${address}`);
      writes.push({ address, arg: fromHuman(def, value) });
    };

    const pushMapped = (
      section: Record<string, unknown> | undefined,
      fields: FieldMap,
      prefix = ref.root,
    ): void => {
      if (!section) return;
      for (const [field, suffix] of Object.entries(fields)) {
        const value = section[field];
        if (value === undefined) continue;
        push(`${prefix}/${suffix}`, value as HumanValue);
      }
    };

    if (update.config) {
      if (update.config.source !== undefined && !caps.source) {
        throw new BadRequestException(`${ref.id} has no input source selector`);
      }
      pushMapped(
        update.config as unknown as Record<string, unknown>,
        CONFIG_FIELDS,
      );
    }

    if (update.mix) {
      const mix = update.mix;
      if (mix.muted !== undefined) {
        // The console stores "on", which is the inverse of muted.
        push(this.muteAddress(ref), !mix.muted);
      }
      if (mix.faderDb !== undefined) push(this.faderAddress(ref), mix.faderDb);
      if (!caps.mix) {
        if (
          mix.pan !== undefined ||
          mix.stereo !== undefined ||
          mix.mono !== undefined
        ) {
          throw new BadRequestException(
            `${ref.id} has only a fader and a mute`,
          );
        }
      } else {
        if (mix.pan !== undefined) push(`${ref.root}/mix/pan`, mix.pan);
        if (mix.stereo !== undefined) push(`${ref.root}/mix/st`, mix.stereo);
        if (mix.mono !== undefined) push(`${ref.root}/mix/mono`, mix.mono);
        if (mix.monoLevelDb !== undefined)
          push(`${ref.root}/mix/mlevel`, mix.monoLevelDb);
      }
    }

    if (update.sends) {
      if (caps.sends === 0)
        throw new BadRequestException(`${ref.id} has no sends`);
      for (const send of update.sends) {
        if (send.to < 1 || send.to > caps.sends) {
          throw new BadRequestException(
            `${ref.id} sends to 1..${caps.sends}, not ${send.to}`,
          );
        }
        const sendRoot = `${ref.root}/mix/${pad2(send.to)}`;
        if (send.on !== undefined) push(`${sendRoot}/on`, send.on);
        if (send.levelDb !== undefined) push(`${sendRoot}/level`, send.levelDb);
        if (send.pan !== undefined) push(`${sendRoot}/pan`, send.pan);
      }
    }

    if (update.preamp) {
      if (!caps.preamp)
        throw new BadRequestException(`${ref.id} has no preamp`);
      const { gainDb, phantom, ...strip } = update.preamp;
      pushMapped(strip as Record<string, unknown>, PREAMP_FIELDS);

      if (gainDb !== undefined || phantom !== undefined) {
        const input = headampIndexFor(ref);
        if (input === undefined) {
          throw new BadRequestException(
            `${ref.id} is not fed by a local head amp`,
          );
        }
        if (gainDb !== undefined) push(`${headampRoot(input)}/gain`, gainDb);
        if (phantom !== undefined)
          push(`${headampRoot(input)}/phantom`, phantom);
      }
    }

    if (update.gate) {
      if (!caps.gate) throw new BadRequestException(`${ref.id} has no gate`);
      pushMapped(
        update.gate as unknown as Record<string, unknown>,
        GATE_FIELDS,
      );
    }

    if (update.dynamics) {
      if (!caps.dyn) throw new BadRequestException(`${ref.id} has no dynamics`);
      pushMapped(
        update.dynamics as unknown as Record<string, unknown>,
        DYN_FIELDS,
      );
    }

    if (update.eq) {
      if (caps.eqBands === 0)
        throw new BadRequestException(`${ref.id} has no EQ`);
      if (update.eq.on !== undefined) push(`${ref.root}/eq/on`, update.eq.on);
      for (const band of update.eq.bands ?? []) {
        if (band.band < 1 || band.band > caps.eqBands) {
          throw new BadRequestException(
            `${ref.id} has ${caps.eqBands} EQ bands, not band ${band.band}`,
          );
        }
        pushMapped(
          band as unknown as Record<string, unknown>,
          EQ_BAND_FIELDS,
          `${ref.root}/eq/${band.band}`,
        );
      }
    }

    return writes;
  }

  /* -------------------------------- helpers ------------------------------- */

  /** A DCA keeps its fader and mute on the root; everything else under /mix. */
  private faderAddress(ref: StripRef): string {
    return ref.capabilities.mix ? `${ref.root}/mix/fader` : `${ref.root}/fader`;
  }

  private muteAddress(ref: StripRef): string {
    return ref.capabilities.mix ? `${ref.root}/mix/on` : `${ref.root}/on`;
  }

  private connection(consoleId: string): ConsoleConnection {
    const connection = this.consoles.require(consoleId);
    if (connection.state === 'disconnected') {
      throw new ServiceUnavailableException(
        `console "${consoleId}" is not connected (${connection.state})`,
      );
    }
    return connection;
  }

  private read(
    connection: ConsoleConnection,
    address: string,
  ): HumanValue | undefined {
    return connection.cache.getValue(address);
  }

  /**
   * Makes sure the containers this strip needs are in the mirror.
   *
   * The deep sync stages run in the background after connect, so a strip may
   * be asked for before its EQ has arrived. Rather than answer with holes, the
   * missing containers are fetched once — after which the feed keeps them
   * current like everything else.
   */
  private async ensureLoaded(
    connection: ConsoleConnection,
    ref: StripRef,
  ): Promise<void> {
    const caps = ref.capabilities;
    const containers: string[] = [caps.mix ? `${ref.root}/mix` : ref.root];
    if (caps.config) containers.push(`${ref.root}/config`);
    if (caps.preamp) containers.push(`${ref.root}/preamp`);
    if (caps.gate) containers.push(`${ref.root}/gate`);
    if (caps.dyn) containers.push(`${ref.root}/dyn`);
    if (caps.eqBands > 0) {
      containers.push(`${ref.root}/eq`);
      for (let band = 1; band <= caps.eqBands; band += 1) {
        containers.push(`${ref.root}/eq/${band}`);
      }
    }
    for (let send = 1; send <= caps.sends; send += 1) {
      containers.push(`${ref.root}/mix/${pad2(send)}`);
    }

    const missing = containers.filter(
      (address) => !this.isLoaded(connection, address),
    );
    if (missing.length === 0) return;

    const input = headampIndexFor(ref);
    if (input !== undefined && !this.isLoaded(connection, headampRoot(input))) {
      missing.push(headampRoot(input));
    }

    for (const address of missing) {
      try {
        const reply = await connection.osc.nodeQuery(
          address.replace(/^\//, ''),
          {
            priority: OscPriority.Command,
          },
        );
        const dump = reply.args[0];
        if (dump?.type === 's')
          connection.cache.applyNodeDump(dump.value, 'sync');
      } catch {
        // Leave the gap: a missing value reads as its default rather than
        // failing the whole request.
      }
    }
  }

  private isLoaded(connection: ConsoleConnection, container: string): boolean {
    const def = containerFor(container);
    if (!def) return true;
    return def.children.every((child) =>
      connection.cache.has(`${container}/${child.name}`),
    );
  }

  /* --------------------------------- readers ------------------------------ */

  private readConfig(
    connection: ConsoleConnection,
    ref: StripRef,
  ): StripConfigDto {
    const config: StripConfigDto = {
      name: (this.read(connection, `${ref.root}/config/name`) as string) ?? '',
      icon: (this.read(connection, `${ref.root}/config/icon`) as number) ?? 0,
      color:
        (this.read(connection, `${ref.root}/config/color`) as string) ?? 'OFF',
    };
    if (ref.capabilities.source) {
      config.source =
        (this.read(connection, `${ref.root}/config/source`) as number) ?? 0;
    }
    return config;
  }

  private readMix(connection: ConsoleConnection, ref: StripRef): StripMixDto {
    const mix: StripMixDto = {
      muted: this.read(connection, this.muteAddress(ref)) === false,
      faderDb: (this.read(connection, this.faderAddress(ref)) as number) ?? -90,
      pan: 0,
    };
    if (!ref.capabilities.mix) return mix;

    mix.pan = (this.read(connection, `${ref.root}/mix/pan`) as number) ?? 0;
    mix.stereo =
      (this.read(connection, `${ref.root}/mix/st`) as boolean) ?? false;
    mix.mono =
      (this.read(connection, `${ref.root}/mix/mono`) as boolean) ?? false;
    mix.monoLevelDb =
      (this.read(connection, `${ref.root}/mix/mlevel`) as number) ?? -90;
    return mix;
  }

  private readSends(connection: ConsoleConnection, ref: StripRef): SendDto[] {
    const sends: SendDto[] = [];
    for (let to = 1; to <= ref.capabilities.sends; to += 1) {
      const root = `${ref.root}/mix/${pad2(to)}`;
      sends.push({
        to,
        on: (this.read(connection, `${root}/on`) as boolean) ?? false,
        levelDb: (this.read(connection, `${root}/level`) as number) ?? -90,
        pan: (this.read(connection, `${root}/pan`) as number) ?? 0,
      });
    }
    return sends;
  }

  private readPreamp(connection: ConsoleConnection, ref: StripRef): PreampDto {
    const preamp: PreampDto = {
      trimDb: (this.read(connection, `${ref.root}/preamp/trim`) as number) ?? 0,
      invert:
        (this.read(connection, `${ref.root}/preamp/invert`) as boolean) ??
        false,
      lowCutOn:
        (this.read(connection, `${ref.root}/preamp/hpon`) as boolean) ?? false,
      lowCutHz:
        (this.read(connection, `${ref.root}/preamp/hpf`) as number) ?? 20,
    };

    const input = headampIndexFor(ref);
    if (input !== undefined) {
      preamp.gainDb =
        (this.read(connection, `${headampRoot(input)}/gain`) as number) ?? 0;
      preamp.phantom =
        (this.read(connection, `${headampRoot(input)}/phantom`) as boolean) ??
        false;
    }
    return preamp;
  }

  private readGate(connection: ConsoleConnection, ref: StripRef): GateDto {
    return {
      on: (this.read(connection, `${ref.root}/gate/on`) as boolean) ?? false,
      mode:
        (this.read(connection, `${ref.root}/gate/mode`) as string) ?? 'GATE',
      thresholdDb:
        (this.read(connection, `${ref.root}/gate/thr`) as number) ?? -80,
      rangeDb: (this.read(connection, `${ref.root}/gate/range`) as number) ?? 3,
      attackMs:
        (this.read(connection, `${ref.root}/gate/attack`) as number) ?? 0,
      holdMs:
        (this.read(connection, `${ref.root}/gate/hold`) as number) ?? 0.02,
      releaseMs:
        (this.read(connection, `${ref.root}/gate/release`) as number) ?? 5,
    };
  }

  private readDynamics(
    connection: ConsoleConnection,
    ref: StripRef,
  ): DynamicsDto {
    return {
      on: (this.read(connection, `${ref.root}/dyn/on`) as boolean) ?? false,
      mode: (this.read(connection, `${ref.root}/dyn/mode`) as string) ?? 'COMP',
      detection:
        (this.read(connection, `${ref.root}/dyn/det`) as string) ?? 'PEAK',
      envelope:
        (this.read(connection, `${ref.root}/dyn/env`) as string) ?? 'LIN',
      thresholdDb:
        (this.read(connection, `${ref.root}/dyn/thr`) as number) ?? -60,
      ratio: (this.read(connection, `${ref.root}/dyn/ratio`) as number) ?? 1.1,
      knee: (this.read(connection, `${ref.root}/dyn/knee`) as number) ?? 0,
      makeupGainDb:
        (this.read(connection, `${ref.root}/dyn/mgain`) as number) ?? 0,
      attackMs:
        (this.read(connection, `${ref.root}/dyn/attack`) as number) ?? 0,
      holdMs: (this.read(connection, `${ref.root}/dyn/hold`) as number) ?? 0.02,
      releaseMs:
        (this.read(connection, `${ref.root}/dyn/release`) as number) ?? 5,
      position:
        (this.read(connection, `${ref.root}/dyn/pos`) as string) ?? 'PRE',
      mixPercent:
        (this.read(connection, `${ref.root}/dyn/mix`) as number) ?? 100,
    };
  }

  private readEq(connection: ConsoleConnection, ref: StripRef): EqDto {
    const bands: EqBandDto[] = [];
    for (let band = 1; band <= ref.capabilities.eqBands; band += 1) {
      const root = `${ref.root}/eq/${band}`;
      bands.push({
        band,
        type: (this.read(connection, `${root}/type`) as string) ?? 'PEQ',
        frequencyHz: (this.read(connection, `${root}/f`) as number) ?? 20,
        gainDb: (this.read(connection, `${root}/g`) as number) ?? 0,
        q: (this.read(connection, `${root}/q`) as number) ?? 2,
      });
    }
    return {
      on: (this.read(connection, `${ref.root}/eq/on`) as boolean) ?? false,
      bands,
    };
  }
}
