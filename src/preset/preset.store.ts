/**
 * Storage for venue presets.
 *
 * Behind an interface for a reason that matters to this project's promise:
 * cloning the repository and running `npm run start:dev` has to work with no
 * infrastructure at all. Without `DATABASE_URL` the API runs on the in-memory
 * store — everything works, nothing survives a restart, and it says so at boot.
 * With `DATABASE_URL` set it is PostgreSQL through Prisma, and presets outlive
 * the process, the laptop and the show.
 *
 * The same interface keeps the test suite free of a database, which is what
 * lets the whole suite run in CI with neither a console nor a server.
 */

export interface VenueRecord {
  id: string;
  name: string;
  roomSize?: string | null;
  notes?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface BandRecord {
  id: string;
  name: string;
  notes?: string | null;
  /** Input list: what is plugged into what, and how it starts out. */
  inputList?: InputListEntry[] | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface InputListEntry {
  /** Channel number on the console. */
  input: number;
  name: string;
  color?: string;
  /** Head amp gain to start from, in dB. */
  gainDb?: number;
  phantom?: boolean;
  notes?: string;
}

export interface PresetRecord {
  id: string;
  name: string;
  description?: string | null;
  venueId?: string | null;
  bandId?: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface PresetVersionRecord {
  id: string;
  presetId: string;
  version: number;
  /** Parameter address -> value in API units. */
  values: Record<string, string | number | boolean>;
  note?: string | null;
  createdBy?: string | null;
  createdAt: Date;
}

export interface CreateVenueInput {
  name: string;
  roomSize?: string;
  notes?: string;
}

export interface CreateBandInput {
  name: string;
  notes?: string;
  inputList?: InputListEntry[];
}

export interface CreatePresetInput {
  name: string;
  description?: string;
  venueId?: string;
  bandId?: string;
  values: Record<string, string | number | boolean>;
  note?: string;
  createdBy?: string;
}

export interface PresetFilter {
  venueId?: string;
  bandId?: string;
}

/** Everything the preset service needs from storage. */
export interface PresetStore {
  readonly kind: 'memory' | 'postgres';

  createVenue(input: CreateVenueInput): Promise<VenueRecord>;
  listVenues(): Promise<VenueRecord[]>;
  findVenue(id: string): Promise<VenueRecord | undefined>;
  updateVenue(
    id: string,
    input: Partial<CreateVenueInput>,
  ): Promise<VenueRecord>;
  deleteVenue(id: string): Promise<void>;

  createBand(input: CreateBandInput): Promise<BandRecord>;
  listBands(): Promise<BandRecord[]>;
  findBand(id: string): Promise<BandRecord | undefined>;
  updateBand(id: string, input: Partial<CreateBandInput>): Promise<BandRecord>;
  deleteBand(id: string): Promise<void>;

  createPreset(input: CreatePresetInput): Promise<PresetRecord>;
  listPresets(filter?: PresetFilter): Promise<PresetRecord[]>;
  findPreset(id: string): Promise<PresetRecord | undefined>;
  deletePreset(id: string): Promise<void>;

  /** Adds a revision and moves the preset's head to it. */
  addVersion(
    presetId: string,
    values: Record<string, string | number | boolean>,
    note?: string,
    createdBy?: string,
  ): Promise<PresetVersionRecord>;
  listVersions(presetId: string): Promise<PresetVersionRecord[]>;
  findVersion(
    presetId: string,
    version: number,
  ): Promise<PresetVersionRecord | undefined>;
  /** Moves the head back to an earlier revision, without deleting anything. */
  setCurrentVersion(presetId: string, version: number): Promise<PresetRecord>;
}

export const PRESET_STORE = Symbol('PRESET_STORE');
