import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
} from '@nestjs/common';
import {
  ApplyReport,
  ApplyService,
  DesiredValue,
} from '../apply/apply.service.js';
import { ConsoleManagerService } from '../console/console-manager.service.js';
import { ConsoleConnection } from '../console/connection/console-connection.js';
import {
  processingPaths,
  sendPaths,
  surfacePaths,
} from '../console/state/sync-paths.js';
import { message } from '../osc/codec/osc-codec.js';
import {
  argAsNumber,
  argAsString,
  oscInt,
  oscString,
} from '../osc/codec/osc-types.js';
import { OscPriority } from '../osc/rate-limit/osc-rate-limiter.js';
import { paramFor, toHuman } from '../osc/schema/x32-schema.js';
import {
  ScnFile,
  ScnParseError,
  parseScnFile,
  serializeScnFile,
} from './scn/scn-file.js';

/**
 * Scenes, cues and snippets on the console itself, and the `.scn` file format.
 *
 * Recall is well-trodden ground and is used freely. **Writing** to the console's
 * show file is not: the exact `/save` contract is not something this project can
 * verify against hardware, and getting it wrong overwrites somebody's show. So
 * saving requires an explicit confirmation token, and says plainly in its own
 * response that it is unverified.
 */

export const SCENE_SLOTS = 100;
export const CUE_SLOTS = 100;
export const SNIPPET_SLOTS = 100;

export type ShowSlotKind = 'scene' | 'cue' | 'snippet';

export interface ShowSlot {
  readonly index: number;
  readonly name: string;
  readonly note?: string;
}

export interface ImportOptions {
  /** Send the file to the console. Without this, the import only reports. */
  readonly apply?: boolean;
  readonly rampMs?: number;
  readonly confirm?: string;
}

export interface ImportReport {
  readonly name: string;
  readonly note: string;
  readonly version: string;
  readonly parsedValues: number;
  readonly unknownLines: number;
  readonly rejectedLines: readonly string[];
  readonly applied: boolean;
  readonly apply?: ApplyReport;
}

const RECALL_ACTIONS: Record<ShowSlotKind, string> = {
  scene: '/-action/goscene',
  cue: '/-action/gocue',
  snippet: '/-action/gosnippet',
};

const SLOT_COUNTS: Record<ShowSlotKind, number> = {
  scene: SCENE_SLOTS,
  cue: CUE_SLOTS,
  snippet: SNIPPET_SLOTS,
};

/** Overwriting a console's show file takes more than a stray click. */
export const CONFIRM_TOKEN = 'OVERWRITE';

@Injectable()
export class SceneService {
  private readonly logger = new Logger(SceneService.name);

  constructor(
    private readonly consoles: ConsoleManagerService,
    private readonly apply: ApplyService,
  ) {}

  /** Names of the occupied slots of one kind. */
  async list(consoleId: string, kind: ShowSlotKind): Promise<ShowSlot[]> {
    const connection = this.consoles.require(consoleId);
    const slots: ShowSlot[] = [];

    const indices = Array.from({ length: SLOT_COUNTS[kind] }, (_, i) => i);
    await runWithConcurrency(indices, 8, async (index) => {
      const name = await this.readSlotField(connection, kind, index, 'name');
      if (name === undefined || name.length === 0) return;
      const note =
        kind === 'scene'
          ? await this.readSlotField(connection, kind, index, 'notes')
          : undefined;
      slots.push({ index, name, note });
    });

    return slots.sort((a, b) => a.index - b.index);
  }

  async recall(
    consoleId: string,
    kind: ShowSlotKind,
    index: number,
  ): Promise<void> {
    if (!Number.isInteger(index) || index < 0 || index >= SLOT_COUNTS[kind]) {
      throw new BadRequestException(
        `${kind} index must be 0..${SLOT_COUNTS[kind] - 1}`,
      );
    }
    const connection = this.consoles.require(consoleId);
    await connection.osc.send(
      message(RECALL_ACTIONS[kind], oscInt(index)),
      OscPriority.Command,
    );
    this.logger.log(`${consoleId}: recalled ${kind} ${index}`);

    // A recall changes hundreds of parameters at once. The feed reports them,
    // but a re-read of the surface is the cheap way to be certain the mirror
    // matches what the operator is now looking at.
    await connection.sync('surface');
  }

  /** Index of the cue the console is sitting on, if it reports one. */
  async currentCue(consoleId: string): Promise<number | undefined> {
    const connection = this.consoles.require(consoleId);
    try {
      const reply = await connection.osc.get('/-show/prepos/current', {
        priority: OscPriority.Housekeeping,
      });
      return argAsNumber(reply.args[0]);
    } catch {
      return undefined;
    }
  }

  /**
   * Writes the console's current state into one of its scene slots.
   *
   * Unverified against hardware, and destructive if the slot is in use, so it
   * takes a confirmation token.
   */
  async saveScene(
    consoleId: string,
    index: number,
    name: string,
    note: string,
    confirm: string | undefined,
  ): Promise<{ index: number; name: string; verified: false }> {
    if (confirm !== CONFIRM_TOKEN) {
      throw new ForbiddenException(
        `saving overwrites scene ${index} on the console itself. Repeat the request with ` +
          `confirm="${CONFIRM_TOKEN}" if that is intended.`,
      );
    }
    if (!Number.isInteger(index) || index < 0 || index >= SCENE_SLOTS) {
      throw new BadRequestException(
        `scene index must be 0..${SCENE_SLOTS - 1}`,
      );
    }

    const connection = this.consoles.require(consoleId);
    await connection.osc.send(
      message(
        '/save',
        oscString('scene'),
        oscInt(index),
        oscString(name),
        oscString(note),
      ),
      OscPriority.Command,
    );
    this.logger.warn(
      `${consoleId}: wrote scene ${index} ("${name}") on the console`,
    );
    return { index, name, verified: false };
  }

  /* ------------------------------- .scn files ----------------------------- */

  /**
   * Writes the console's current mixing state as a `.scn` file.
   *
   * What it contains is what this project models — strips, sends, processing —
   * so it is a mixing snapshot, not a full show backup. Routing, effects and
   * the recorder are absent, and loading the file leaves those as they are.
   */
  exportScn(consoleId: string, name: string, note = ''): string {
    const connection = this.consoles.require(consoleId);
    return serializeScnFile({
      name,
      note,
      containers: [...surfacePaths(), ...sendPaths(), ...processingPaths()],
      read: (address) => connection.cache.get(address),
    });
  }

  /** Parses a `.scn` file and, if asked, applies it to the console. */
  async importScn(
    consoleId: string,
    content: string,
    options: ImportOptions = {},
  ): Promise<ImportReport> {
    const connection = this.consoles.require(consoleId);
    let file: ScnFile;
    try {
      file = parseScnFile(content);
    } catch (error) {
      // A file the user picked by mistake is their problem to fix, not a
      // server fault.
      if (error instanceof ScnParseError)
        throw new BadRequestException(error.message);
      throw error;
    }

    const report: ImportReport = {
      name: file.header.name,
      note: file.header.note,
      version: file.header.version,
      parsedValues: file.values.size,
      unknownLines: file.unknownLines.length,
      rejectedLines: file.rejectedLines,
      applied: false,
    };

    if (!options.apply) return report;
    if (options.confirm !== CONFIRM_TOKEN) {
      throw new ForbiddenException(
        `applying "${file.header.name}" will change the live console. Repeat the request ` +
          `with confirm="${CONFIRM_TOKEN}" once the room is ready.`,
      );
    }

    const desired = toDesiredValues(file);
    const applied = await this.apply.apply(connection, desired, {
      rampMs: options.rampMs,
    });
    this.logger.log(
      `${consoleId}: loaded scene file "${file.header.name}" — ${applied.changed} changes`,
    );
    return { ...report, applied: true, apply: applied };
  }

  private async readSlotField(
    connection: ConsoleConnection,
    kind: ShowSlotKind,
    index: number,
    field: 'name' | 'notes',
  ): Promise<string | undefined> {
    const address = `/-show/showfile/${kind}/${String(index).padStart(3, '0')}/${field}`;
    try {
      const reply = await connection.osc.get(address, {
        priority: OscPriority.Polling,
      });
      return argAsString(reply.args[0]);
    } catch {
      return undefined;
    }
  }
}

/** Scene file values are raw; the apply path speaks API units. */
export function toDesiredValues(file: ScnFile): DesiredValue[] {
  const desired: DesiredValue[] = [];
  for (const [address, args] of file.values) {
    const def = paramFor(address);
    if (!def || args.length === 0) continue;
    desired.push({ address, value: toHuman(def, args[0]) });
  }
  return desired;
}

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
