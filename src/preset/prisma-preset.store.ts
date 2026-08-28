import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  OnModuleDestroy,
} from '@nestjs/common';
import { PrismaPg } from '@prisma/adapter-pg';
import { Prisma, PrismaClient } from '../generated/prisma/client.js';
import {
  BandRecord,
  CreateBandInput,
  CreatePresetInput,
  CreateVenueInput,
  InputListEntry,
  PresetFilter,
  PresetRecord,
  PresetStore,
  PresetVersionRecord,
  VenueRecord,
} from './preset.store.js';

/**
 * PostgreSQL-backed preset storage.
 *
 * Used when `DATABASE_URL` is set. The application builds its own client from
 * that variable through the pg adapter — Prisma 7 keeps the connection URL out
 * of the schema file, where only migrations read it.
 */
@Injectable()
export class PrismaPresetStore implements PresetStore, OnModuleDestroy {
  readonly kind = 'postgres' as const;

  private readonly logger = new Logger(PrismaPresetStore.name);
  private readonly prisma: PrismaClient;

  constructor(connectionString: string) {
    this.prisma = new PrismaClient({
      adapter: new PrismaPg({ connectionString }),
    });
  }

  async onModuleDestroy(): Promise<void> {
    await this.prisma.$disconnect();
  }

  /** Verifies the database is actually reachable, so failures surface at boot. */
  async connect(): Promise<void> {
    await this.prisma.$queryRaw`SELECT 1`;
    this.logger.log('preset storage: PostgreSQL');
  }

  /* --------------------------------- venues -------------------------------- */

  async createVenue(input: CreateVenueInput): Promise<VenueRecord> {
    try {
      return await this.prisma.venue.create({ data: input });
    } catch (error) {
      throw this.translate(
        error,
        `a venue called "${input.name}" already exists`,
      );
    }
  }

  listVenues(): Promise<VenueRecord[]> {
    return this.prisma.venue.findMany({ orderBy: { name: 'asc' } });
  }

  async findVenue(id: string): Promise<VenueRecord | undefined> {
    return (await this.prisma.venue.findUnique({ where: { id } })) ?? undefined;
  }

  async updateVenue(
    id: string,
    input: Partial<CreateVenueInput>,
  ): Promise<VenueRecord> {
    await this.requireVenue(id);
    return this.prisma.venue.update({ where: { id }, data: input });
  }

  async deleteVenue(id: string): Promise<void> {
    await this.prisma.venue.deleteMany({ where: { id } });
  }

  /* --------------------------------- bands --------------------------------- */

  async createBand(input: CreateBandInput): Promise<BandRecord> {
    try {
      const band = await this.prisma.band.create({
        data: {
          name: input.name,
          notes: input.notes,
          // Prisma's JSON input type does not accept a typed array directly.
          inputList: input.inputList ? toJson(input.inputList) : undefined,
        },
      });
      return toBandRecord(band);
    } catch (error) {
      throw this.translate(
        error,
        `a band called "${input.name}" already exists`,
      );
    }
  }

  async listBands(): Promise<BandRecord[]> {
    const bands = await this.prisma.band.findMany({ orderBy: { name: 'asc' } });
    return bands.map(toBandRecord);
  }

  async findBand(id: string): Promise<BandRecord | undefined> {
    const band = await this.prisma.band.findUnique({ where: { id } });
    return band ? toBandRecord(band) : undefined;
  }

  async updateBand(
    id: string,
    input: Partial<CreateBandInput>,
  ): Promise<BandRecord> {
    await this.requireBand(id);
    const band = await this.prisma.band.update({
      where: { id },
      data: {
        name: input.name,
        notes: input.notes,
        inputList: input.inputList ? toJson(input.inputList) : undefined,
      },
    });
    return toBandRecord(band);
  }

  async deleteBand(id: string): Promise<void> {
    await this.prisma.band.deleteMany({ where: { id } });
  }

  /* -------------------------------- presets -------------------------------- */

  async createPreset(input: CreatePresetInput): Promise<PresetRecord> {
    try {
      // One transaction: a preset without its first version would be a preset
      // that cannot be applied.
      return await this.prisma.$transaction(async (tx) => {
        const preset = await tx.preset.create({
          data: {
            name: input.name,
            description: input.description,
            venueId: input.venueId,
            bandId: input.bandId,
            version: 1,
          },
        });
        await tx.presetVersion.create({
          data: {
            presetId: preset.id,
            version: 1,
            values: toJson(input.values),
            note: input.note,
            createdBy: input.createdBy,
          },
        });
        return preset;
      });
    } catch (error) {
      throw this.translate(
        error,
        `a preset called "${input.name}" already exists for that venue and band`,
      );
    }
  }

  listPresets(filter: PresetFilter = {}): Promise<PresetRecord[]> {
    return this.prisma.preset.findMany({
      where: { venueId: filter.venueId, bandId: filter.bandId },
      orderBy: { name: 'asc' },
    });
  }

  async findPreset(id: string): Promise<PresetRecord | undefined> {
    return (
      (await this.prisma.preset.findUnique({ where: { id } })) ?? undefined
    );
  }

  async deletePreset(id: string): Promise<void> {
    await this.prisma.preset.deleteMany({ where: { id } });
  }

  /* -------------------------------- versions ------------------------------- */

  async addVersion(
    presetId: string,
    values: Record<string, string | number | boolean>,
    note?: string,
    createdBy?: string,
  ): Promise<PresetVersionRecord> {
    return this.prisma.$transaction(async (tx) => {
      const preset = await tx.preset.findUnique({ where: { id: presetId } });
      if (!preset) throw new NotFoundException(`no preset ${presetId}`);

      // Numbered from the highest that ever existed, not from the current
      // head: after a rollback, a new save must not overwrite history.
      const latest = await tx.presetVersion.findFirst({
        where: { presetId },
        orderBy: { version: 'desc' },
      });
      const version = (latest?.version ?? 0) + 1;

      const created = await tx.presetVersion.create({
        data: { presetId, version, values: toJson(values), note, createdBy },
      });
      await tx.preset.update({ where: { id: presetId }, data: { version } });
      return toVersionRecord(created);
    });
  }

  async listVersions(presetId: string): Promise<PresetVersionRecord[]> {
    const versions = await this.prisma.presetVersion.findMany({
      where: { presetId },
      orderBy: { version: 'desc' },
    });
    return versions.map(toVersionRecord);
  }

  async findVersion(
    presetId: string,
    version: number,
  ): Promise<PresetVersionRecord | undefined> {
    const found = await this.prisma.presetVersion.findUnique({
      where: { presetId_version: { presetId, version } },
    });
    return found ? toVersionRecord(found) : undefined;
  }

  async setCurrentVersion(
    presetId: string,
    version: number,
  ): Promise<PresetRecord> {
    const exists = await this.findVersion(presetId, version);
    if (!exists)
      throw new NotFoundException(
        `preset ${presetId} has no version ${version}`,
      );
    return this.prisma.preset.update({
      where: { id: presetId },
      data: { version },
    });
  }

  /* -------------------------------- helpers -------------------------------- */

  private async requireVenue(id: string): Promise<void> {
    if (!(await this.findVenue(id)))
      throw new NotFoundException(`no venue ${id}`);
  }

  private async requireBand(id: string): Promise<void> {
    if (!(await this.findBand(id)))
      throw new NotFoundException(`no band ${id}`);
  }

  /** A unique-constraint violation is a 409, not a 500. */
  private translate(error: unknown, conflictMessage: string): unknown {
    const code = (error as { code?: string }).code;
    if (code === 'P2002') return new ConflictException(conflictMessage);
    return error;
  }
}

/** Widens typed data to the shape Prisma's JSON columns accept. */
function toJson<T>(value: T): Prisma.InputJsonValue {
  return value as unknown as Prisma.InputJsonValue;
}

function toBandRecord(band: {
  id: string;
  name: string;
  notes: string | null;
  inputList: unknown;
  createdAt: Date;
  updatedAt: Date;
}): BandRecord {
  return {
    id: band.id,
    name: band.name,
    notes: band.notes,
    inputList: (band.inputList as InputListEntry[] | null) ?? null,
    createdAt: band.createdAt,
    updatedAt: band.updatedAt,
  };
}

function toVersionRecord(version: {
  id: string;
  presetId: string;
  version: number;
  values: unknown;
  note: string | null;
  createdBy: string | null;
  createdAt: Date;
}): PresetVersionRecord {
  return {
    id: version.id,
    presetId: version.presetId,
    version: version.version,
    values: (version.values ?? {}) as Record<string, string | number | boolean>,
    note: version.note,
    createdBy: version.createdBy,
    createdAt: version.createdAt,
  };
}
