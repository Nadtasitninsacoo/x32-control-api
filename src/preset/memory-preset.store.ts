import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  BandRecord,
  CreateBandInput,
  CreatePresetInput,
  CreateVenueInput,
  PresetFilter,
  PresetRecord,
  PresetStore,
  PresetVersionRecord,
  VenueRecord,
} from './preset.store.js';

/**
 * The store used when no database is configured.
 *
 * It is a real implementation, not a stub: everything works, and the only
 * difference is that nothing survives a restart. That is what lets a fresh
 * clone run, and what lets the test suite stay free of a database.
 */
@Injectable()
export class MemoryPresetStore implements PresetStore {
  readonly kind = 'memory' as const;

  private readonly venues = new Map<string, VenueRecord>();
  private readonly bands = new Map<string, BandRecord>();
  private readonly presets = new Map<string, PresetRecord>();
  private readonly versions = new Map<string, PresetVersionRecord[]>();

  /* --------------------------------- venues -------------------------------- */

  async createVenue(input: CreateVenueInput): Promise<VenueRecord> {
    if ([...this.venues.values()].some((venue) => venue.name === input.name)) {
      throw new ConflictException(
        `a venue called "${input.name}" already exists`,
      );
    }
    const now = new Date();
    const venue: VenueRecord = {
      id: randomUUID(),
      name: input.name,
      roomSize: input.roomSize ?? null,
      notes: input.notes ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.venues.set(venue.id, venue);
    return venue;
  }

  async listVenues(): Promise<VenueRecord[]> {
    return [...this.venues.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async findVenue(id: string): Promise<VenueRecord | undefined> {
    return this.venues.get(id);
  }

  async updateVenue(
    id: string,
    input: Partial<CreateVenueInput>,
  ): Promise<VenueRecord> {
    const venue = this.venues.get(id);
    if (!venue) throw new NotFoundException(`no venue ${id}`);
    const updated: VenueRecord = {
      ...venue,
      name: input.name ?? venue.name,
      roomSize: input.roomSize ?? venue.roomSize,
      notes: input.notes ?? venue.notes,
      updatedAt: new Date(),
    };
    this.venues.set(id, updated);
    return updated;
  }

  async deleteVenue(id: string): Promise<void> {
    this.venues.delete(id);
    for (const preset of this.presets.values()) {
      if (preset.venueId === id) preset.venueId = null;
    }
  }

  /* --------------------------------- bands --------------------------------- */

  async createBand(input: CreateBandInput): Promise<BandRecord> {
    if ([...this.bands.values()].some((band) => band.name === input.name)) {
      throw new ConflictException(
        `a band called "${input.name}" already exists`,
      );
    }
    const now = new Date();
    const band: BandRecord = {
      id: randomUUID(),
      name: input.name,
      notes: input.notes ?? null,
      inputList: input.inputList ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.bands.set(band.id, band);
    return band;
  }

  async listBands(): Promise<BandRecord[]> {
    return [...this.bands.values()].sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }

  async findBand(id: string): Promise<BandRecord | undefined> {
    return this.bands.get(id);
  }

  async updateBand(
    id: string,
    input: Partial<CreateBandInput>,
  ): Promise<BandRecord> {
    const band = this.bands.get(id);
    if (!band) throw new NotFoundException(`no band ${id}`);
    const updated: BandRecord = {
      ...band,
      name: input.name ?? band.name,
      notes: input.notes ?? band.notes,
      inputList: input.inputList ?? band.inputList,
      updatedAt: new Date(),
    };
    this.bands.set(id, updated);
    return updated;
  }

  async deleteBand(id: string): Promise<void> {
    this.bands.delete(id);
    for (const preset of this.presets.values()) {
      if (preset.bandId === id) preset.bandId = null;
    }
  }

  /* -------------------------------- presets -------------------------------- */

  async createPreset(input: CreatePresetInput): Promise<PresetRecord> {
    const clash = [...this.presets.values()].some(
      (preset) =>
        preset.name === input.name &&
        (preset.venueId ?? null) === (input.venueId ?? null) &&
        (preset.bandId ?? null) === (input.bandId ?? null),
    );
    if (clash) {
      throw new ConflictException(
        `a preset called "${input.name}" already exists for that venue and band`,
      );
    }

    const now = new Date();
    const preset: PresetRecord = {
      id: randomUUID(),
      name: input.name,
      description: input.description ?? null,
      venueId: input.venueId ?? null,
      bandId: input.bandId ?? null,
      version: 1,
      createdAt: now,
      updatedAt: now,
    };
    this.presets.set(preset.id, preset);
    this.versions.set(preset.id, [
      {
        id: randomUUID(),
        presetId: preset.id,
        version: 1,
        values: input.values,
        note: input.note ?? null,
        createdBy: input.createdBy ?? null,
        createdAt: now,
      },
    ]);
    return preset;
  }

  async listPresets(filter: PresetFilter = {}): Promise<PresetRecord[]> {
    return [...this.presets.values()]
      .filter((preset) => !filter.venueId || preset.venueId === filter.venueId)
      .filter((preset) => !filter.bandId || preset.bandId === filter.bandId)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async findPreset(id: string): Promise<PresetRecord | undefined> {
    return this.presets.get(id);
  }

  async deletePreset(id: string): Promise<void> {
    this.presets.delete(id);
    this.versions.delete(id);
  }

  /* -------------------------------- versions ------------------------------- */

  async addVersion(
    presetId: string,
    values: Record<string, string | number | boolean>,
    note?: string,
    createdBy?: string,
  ): Promise<PresetVersionRecord> {
    const preset = this.presets.get(presetId);
    if (!preset) throw new NotFoundException(`no preset ${presetId}`);

    const history = this.versions.get(presetId) ?? [];
    // Versions are never renumbered or overwritten, even after a rollback:
    // the history is what makes "put it back how it was" possible.
    const next = Math.max(0, ...history.map((entry) => entry.version)) + 1;

    const version: PresetVersionRecord = {
      id: randomUUID(),
      presetId,
      version: next,
      values,
      note: note ?? null,
      createdBy: createdBy ?? null,
      createdAt: new Date(),
    };
    history.push(version);
    this.versions.set(presetId, history);

    preset.version = next;
    preset.updatedAt = version.createdAt;
    return version;
  }

  async listVersions(presetId: string): Promise<PresetVersionRecord[]> {
    return [...(this.versions.get(presetId) ?? [])].sort(
      (a, b) => b.version - a.version,
    );
  }

  async findVersion(
    presetId: string,
    version: number,
  ): Promise<PresetVersionRecord | undefined> {
    return this.versions
      .get(presetId)
      ?.find((entry) => entry.version === version);
  }

  async setCurrentVersion(
    presetId: string,
    version: number,
  ): Promise<PresetRecord> {
    const preset = this.presets.get(presetId);
    if (!preset) throw new NotFoundException(`no preset ${presetId}`);
    const exists = await this.findVersion(presetId, version);
    if (!exists)
      throw new NotFoundException(
        `preset ${presetId} has no version ${version}`,
      );

    preset.version = version;
    preset.updatedAt = new Date();
    return preset;
  }
}
