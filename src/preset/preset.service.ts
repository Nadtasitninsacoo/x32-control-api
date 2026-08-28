import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ApplyReport,
  ApplyService,
  DesiredValue,
} from '../apply/apply.service.js';
import { ConsoleManagerService } from '../console/console-manager.service.js';
import { ConsoleConnection } from '../console/connection/console-connection.js';
import { headampRoot, pad2 } from '../osc/addresses/x32-addresses.js';
import { containerFor, paramFor } from '../osc/schema/x32-schema.js';
import {
  allStrips,
  headampIndexFor,
  resolveStrip,
} from '../mixer/strip-ref.js';
import type { StripRef } from '../mixer/strip-ref.js';
import { PRESET_STORE } from './preset.store.js';
import type {
  BandRecord,
  CreateBandInput,
  CreateVenueInput,
  InputListEntry,
  PresetRecord,
  PresetStore,
  PresetVersionRecord,
  VenueRecord,
} from './preset.store.js';

/**
 * Venue presets: this project's own library of mixes.
 *
 * A scene on the console belongs to the console — one show file, overwritten by
 * whoever touched it last, gone when the desk is swapped. A preset belongs to
 * the engineer: it is versioned, it says who made it, it can be rolled back,
 * and it can be applied to whichever console is in the room tonight.
 *
 * Applying one is a diff, not a rewrite: only values that actually differ are
 * sent, and levels are ramped rather than jumped.
 */

export type PresetSection =
  'config' | 'mix' | 'sends' | 'preamp' | 'gate' | 'dyn' | 'eq';

export const ALL_SECTIONS: PresetSection[] = [
  'config',
  'mix',
  'sends',
  'preamp',
  'gate',
  'dyn',
  'eq',
];

export interface CaptureOptions {
  /** Strip ids to capture, e.g. `['ch/01', 'bus/03']`. Default: every strip. */
  readonly strips?: readonly string[];
  /** Which parts of each strip to capture. Default: all of them. */
  readonly sections?: readonly PresetSection[];
}

export type PresetValues = Record<string, string | number | boolean>;

@Injectable()
export class PresetService {
  private readonly logger = new Logger(PresetService.name);

  constructor(
    @Inject(PRESET_STORE) private readonly store: PresetStore,
    private readonly consoles: ConsoleManagerService,
    private readonly apply: ApplyService,
  ) {}

  get storageKind(): PresetStore['kind'] {
    return this.store.kind;
  }

  /* --------------------------- venues and bands --------------------------- */

  createVenue(input: CreateVenueInput): Promise<VenueRecord> {
    return this.store.createVenue(input);
  }

  listVenues(): Promise<VenueRecord[]> {
    return this.store.listVenues();
  }

  async getVenue(id: string): Promise<VenueRecord> {
    const venue = await this.store.findVenue(id);
    if (!venue) throw new NotFoundException(`no venue with id "${id}"`);
    return venue;
  }

  updateVenue(
    id: string,
    input: Partial<CreateVenueInput>,
  ): Promise<VenueRecord> {
    return this.store.updateVenue(id, input);
  }

  deleteVenue(id: string): Promise<void> {
    return this.store.deleteVenue(id);
  }

  createBand(input: CreateBandInput): Promise<BandRecord> {
    return this.store.createBand(input);
  }

  listBands(): Promise<BandRecord[]> {
    return this.store.listBands();
  }

  async getBand(id: string): Promise<BandRecord> {
    const band = await this.store.findBand(id);
    if (!band) throw new NotFoundException(`no band with id "${id}"`);
    return band;
  }

  updateBand(id: string, input: Partial<CreateBandInput>): Promise<BandRecord> {
    return this.store.updateBand(id, input);
  }

  deleteBand(id: string): Promise<void> {
    return this.store.deleteBand(id);
  }

  /**
   * Writes a band's input list onto a console: names, colours, gains, phantom.
   *
   * This is the fifteen minutes before doors that everyone recognises — the
   * part where the desk still says "Ch01" and nobody knows which input the
   * kick is on.
   */
  async applyInputList(
    consoleId: string,
    bandId: string,
    options: { rampMs?: number } = {},
  ): Promise<ApplyReport> {
    const band = await this.getBand(bandId);
    const connection = this.connection(consoleId);
    const desired: DesiredValue[] = [];

    for (const entry of band.inputList ?? []) {
      const ref = resolveStrip('ch', String(entry.input));
      desired.push({ address: `${ref.root}/config/name`, value: entry.name });
      if (entry.color)
        desired.push({
          address: `${ref.root}/config/color`,
          value: entry.color,
        });

      const input = headampIndexFor(ref);
      if (input !== undefined) {
        if (entry.gainDb !== undefined) {
          desired.push({
            address: `${headampRoot(input)}/gain`,
            value: entry.gainDb,
          });
        }
        if (entry.phantom !== undefined) {
          desired.push({
            address: `${headampRoot(input)}/phantom`,
            value: entry.phantom,
          });
        }
      }
    }

    const report = await this.apply.apply(connection, desired, {
      rampMs: options.rampMs,
    });
    this.logger.log(`${consoleId}: applied input list for "${band.name}"`);
    return report;
  }

  /* -------------------------------- presets ------------------------------- */

  /** Captures the console's current state (or given values) as a new preset. */
  async createPreset(input: {
    name: string;
    description?: string;
    venueId?: string;
    bandId?: string;
    consoleId?: string;
    values?: PresetValues;
    capture?: CaptureOptions;
    note?: string;
    createdBy?: string;
  }): Promise<PresetRecord> {
    const values =
      input.values ??
      this.capture(
        this.connection(input.consoleId ?? 'default'),
        input.capture ?? {},
      );

    if (input.venueId) await this.getVenue(input.venueId);
    if (input.bandId) await this.getBand(input.bandId);

    const preset = await this.store.createPreset({
      name: input.name,
      description: input.description,
      venueId: input.venueId,
      bandId: input.bandId,
      values,
      note: input.note,
      createdBy: input.createdBy,
    });
    this.logger.log(
      `created preset "${preset.name}" with ${Object.keys(values).length} values`,
    );
    return preset;
  }

  listPresets(
    filter: { venueId?: string; bandId?: string } = {},
  ): Promise<PresetRecord[]> {
    return this.store.listPresets(filter);
  }

  async getPreset(id: string): Promise<PresetRecord> {
    const preset = await this.store.findPreset(id);
    if (!preset) throw new NotFoundException(`no preset with id "${id}"`);
    return preset;
  }

  deletePreset(id: string): Promise<void> {
    return this.store.deletePreset(id);
  }

  /* ------------------------------- versions ------------------------------- */

  async listVersions(presetId: string): Promise<PresetVersionRecord[]> {
    await this.getPreset(presetId);
    return this.store.listVersions(presetId);
  }

  async getVersion(
    presetId: string,
    version?: number,
  ): Promise<PresetVersionRecord> {
    const preset = await this.getPreset(presetId);
    const wanted = version ?? preset.version;
    const found = await this.store.findVersion(presetId, wanted);
    if (!found)
      throw new NotFoundException(
        `preset "${presetId}" has no version ${wanted}`,
      );
    return found;
  }

  /** Saves the console's current state as a new version of an existing preset. */
  async captureVersion(
    presetId: string,
    input: {
      consoleId?: string;
      values?: PresetValues;
      capture?: CaptureOptions;
      note?: string;
      createdBy?: string;
    },
  ): Promise<PresetVersionRecord> {
    await this.getPreset(presetId);
    const values =
      input.values ??
      this.capture(
        this.connection(input.consoleId ?? 'default'),
        input.capture ?? {},
      );
    return this.store.addVersion(presetId, values, input.note, input.createdBy);
  }

  /**
   * Moves the preset's head back to an earlier version.
   * Nothing is deleted: rolling back is itself reversible.
   */
  async rollback(presetId: string, version: number): Promise<PresetRecord> {
    await this.getVersion(presetId, version);
    const preset = await this.store.setCurrentVersion(presetId, version);
    this.logger.log(
      `preset "${preset.name}" rolled back to version ${version}`,
    );
    return preset;
  }

  /* --------------------------- apply and preview -------------------------- */

  /** What applying this preset would change, without sending anything. */
  async preview(
    presetId: string,
    consoleId: string,
    version?: number,
  ): Promise<ReturnType<ApplyService['diff']>> {
    const stored = await this.getVersion(presetId, version);
    return this.apply.diff(
      this.connection(consoleId),
      toDesired(stored.values),
    );
  }

  async applyPreset(
    presetId: string,
    consoleId: string,
    options: { version?: number; rampMs?: number; immediate?: boolean } = {},
  ): Promise<ApplyReport> {
    const preset = await this.getPreset(presetId);
    const stored = await this.getVersion(presetId, options.version);
    const connection = this.connection(consoleId);

    const report = await this.apply.apply(
      connection,
      toDesired(stored.values),
      {
        rampMs: options.rampMs,
        immediate: options.immediate,
      },
    );
    this.logger.log(
      `${consoleId}: applied preset "${preset.name}" v${stored.version} — ` +
        `${report.changed} of ${report.requested} values changed`,
    );
    return report;
  }

  /* -------------------------------- capture ------------------------------- */

  /** Reads the current value of every parameter in scope, in API units. */
  capture(
    connection: ConsoleConnection,
    options: CaptureOptions,
  ): PresetValues {
    const sections = options.sections ?? ALL_SECTIONS;
    const refs = options.strips
      ? options.strips.map((id) => refFromId(id))
      : allStrips();

    const values: PresetValues = {};
    for (const ref of refs) {
      for (const container of containersFor(ref, sections)) {
        const def = containerFor(container);
        if (!def) continue;
        for (const child of def.children) {
          const address = `${container}/${child.name}`;
          const value = connection.cache.getValue(address);
          if (value !== undefined) values[address] = value;
        }
      }

      const input = headampIndexFor(ref);
      if (input !== undefined && sections.includes('preamp')) {
        for (const field of ['gain', 'phantom']) {
          const address = `${headampRoot(input)}/${field}`;
          const value = connection.cache.getValue(address);
          if (value !== undefined) values[address] = value;
        }
      }
    }
    return values;
  }

  private connection(consoleId: string): ConsoleConnection {
    return this.consoles.require(consoleId);
  }
}

/** Container addresses for one strip, limited to the requested sections. */
function containersFor(
  ref: StripRef,
  sections: readonly PresetSection[],
): string[] {
  const caps = ref.capabilities;
  const containers: string[] = [];

  if (sections.includes('config') && caps.config)
    containers.push(`${ref.root}/config`);
  if (sections.includes('mix'))
    containers.push(caps.mix ? `${ref.root}/mix` : ref.root);
  if (sections.includes('sends')) {
    for (let send = 1; send <= caps.sends; send += 1) {
      containers.push(`${ref.root}/mix/${pad2(send)}`);
    }
  }
  if (sections.includes('preamp') && caps.preamp)
    containers.push(`${ref.root}/preamp`);
  if (sections.includes('gate') && caps.gate)
    containers.push(`${ref.root}/gate`);
  if (sections.includes('dyn') && caps.dyn) containers.push(`${ref.root}/dyn`);
  if (sections.includes('eq') && caps.eqBands > 0) {
    containers.push(`${ref.root}/eq`);
    for (let band = 1; band <= caps.eqBands; band += 1) {
      containers.push(`${ref.root}/eq/${band}`);
    }
  }
  return containers;
}

function refFromId(id: string): StripRef {
  const [kind, index] = id.split('/');
  return resolveStrip(kind ?? '', index ?? '');
}

/** Stored values are already in API units; drop any the schema no longer knows. */
export function toDesired(values: PresetValues): DesiredValue[] {
  return Object.entries(values)
    .filter(([address]) => paramFor(address) !== undefined)
    .map(([address, value]) => ({ address, value }));
}

export type { InputListEntry };
