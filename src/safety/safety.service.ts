import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApplyReport,
  ApplyService,
  DesiredValue,
} from '../apply/apply.service.js';
import { EnvVars } from '../config/env.validation.js';
import { ConsoleManagerService } from '../console/console-manager.service.js';
import { allStrips } from '../mixer/strip-ref.js';
import { PresetService } from '../preset/preset.service.js';
import { AUDIT_STORE } from './audit.store.js';
import type {
  AuditEntryRecord,
  AuditQuery,
  AuditStore,
} from './audit.store.js';

/**
 * The parts of this API that exist because it is pointed at a live PA system.
 *
 * Three separate ideas, each covering a different way an evening goes wrong:
 *
 *  - **DRY_RUN** — nothing that changes console state leaves the process.
 *    For rehearsing a show file, or demonstrating the app to a client while
 *    the band is still playing.
 *  - **Read-only** — flip at runtime, no restart. When the guest engineer is
 *    driving and the API is only there to show meters.
 *  - **Panic** — one call, no ramp, no confirmation: put the console back to
 *    the state somebody saved as safe, or mute everything now.
 *
 * Panic deliberately works while read-only is on. Read-only exists to prevent
 * accidents; panic exists to end one.
 */

export type PanicMode = 'safe-state' | 'mute-all';

export interface SafetyStatus {
  readonly dryRun: boolean;
  readonly readOnly: boolean;
  readonly readOnlyReason?: string;
  readonly authEnabled: boolean;
  readonly auditStorage: AuditStore['kind'];
  readonly consolesWithSafeState: readonly string[];
}

export interface PanicResult {
  readonly consoleId: string;
  readonly mode: PanicMode;
  readonly apply: ApplyReport;
  readonly from?: { presetId: string; version: number };
}

/** Safe states are ordinary presets, so they get versioning and history free. */
export const SAFE_STATE_PREFIX = 'Safe state';

const safeStateName = (consoleId: string): string =>
  `${SAFE_STATE_PREFIX} (${consoleId})`;

@Injectable()
export class SafetyService {
  private readonly logger = new Logger(SafetyService.name);

  private readOnlyOverride: boolean | undefined;
  private readOnlyReason: string | undefined;

  constructor(
    private readonly config: ConfigService<EnvVars, true>,
    private readonly consoles: ConsoleManagerService,
    private readonly presets: PresetService,
    private readonly apply: ApplyService,
    @Inject(AUDIT_STORE) private readonly audit: AuditStore,
  ) {}

  get dryRun(): boolean {
    return this.config.get('DRY_RUN', { infer: true });
  }

  get readOnly(): boolean {
    return (
      this.readOnlyOverride ?? this.config.get('READ_ONLY', { infer: true })
    );
  }

  async status(): Promise<SafetyStatus> {
    const safeStates = await this.presets.listPresets();
    return {
      dryRun: this.dryRun,
      readOnly: this.readOnly,
      readOnlyReason: this.readOnlyReason,
      authEnabled: this.config.get('AUTH_ENABLED', { infer: true }),
      auditStorage: this.audit.kind,
      consolesWithSafeState: safeStates
        .filter((preset) => preset.name.startsWith(SAFE_STATE_PREFIX))
        .map((preset) => preset.name.slice(SAFE_STATE_PREFIX.length + 2, -1)),
    };
  }

  setReadOnly(enabled: boolean, reason?: string): void {
    this.readOnlyOverride = enabled;
    this.readOnlyReason = enabled ? reason : undefined;
    this.logger.warn(
      enabled
        ? `read-only mode ON${reason ? `: ${reason}` : ''} — writes are refused until it is lifted`
        : 'read-only mode OFF — writes are allowed again',
    );
  }

  /* --------------------------------- panic -------------------------------- */

  /**
   * Records the console's current state as the one to come back to.
   *
   * Saved as a preset, so it is versioned and inspectable rather than a hidden
   * blob — and so an engineer can look at what "safe" was before trusting it.
   */
  async captureSafeState(
    consoleId: string,
    createdBy?: string,
  ): Promise<{ presetId: string; version: number }> {
    this.consoles.require(consoleId);
    const name = safeStateName(consoleId);
    const existing = (await this.presets.listPresets()).find(
      (preset) => preset.name === name,
    );

    if (existing) {
      const version = await this.presets.captureVersion(existing.id, {
        consoleId,
        note: 'safe state',
        createdBy,
      });
      this.logger.log(
        `safe state for "${consoleId}" updated to version ${version.version}`,
      );
      return { presetId: existing.id, version: version.version };
    }

    const preset = await this.presets.createPreset({
      name,
      description:
        'Captured as the state to return to when PANIC is called. Applied immediately, ' +
        'without ramping.',
      consoleId,
      note: 'safe state',
      createdBy,
    });
    this.logger.log(`safe state for "${consoleId}" captured`);
    return { presetId: preset.id, version: preset.version };
  }

  /**
   * Puts the console back, now.
   *
   * No ramp and no confirmation: a ramp is for a musical transition, and this
   * is not one. Whoever pressed this wants it to have happened already.
   */
  async panic(
    consoleId: string,
    mode: PanicMode = 'safe-state',
  ): Promise<PanicResult> {
    const connection = this.consoles.require(consoleId);

    if (mode === 'mute-all') {
      const report = await this.apply.apply(connection, muteEverything(), {
        immediate: true,
      });
      this.logger.error(`PANIC on "${consoleId}": everything muted`);
      return { consoleId, mode, apply: report };
    }

    const name = safeStateName(consoleId);
    const preset = (await this.presets.listPresets()).find(
      (entry) => entry.name === name,
    );
    if (!preset) {
      throw new NotFoundException(
        `no safe state has been captured for "${consoleId}". Capture one with ` +
          `POST /api/safety/safe-state, or call panic with mode "mute-all".`,
      );
    }

    const report = await this.presets.applyPreset(preset.id, consoleId, {
      immediate: true,
    });
    this.logger.error(
      `PANIC on "${consoleId}": safe state v${preset.version} restored, ` +
        `${report.changed} value(s) changed`,
    );
    return {
      consoleId,
      mode,
      apply: report,
      from: { presetId: preset.id, version: preset.version },
    };
  }

  /* --------------------------------- audit -------------------------------- */

  record(entry: {
    user?: string;
    action: string;
    consoleId?: string;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    return this.audit.record(entry);
  }

  listAudit(query?: AuditQuery): Promise<AuditEntryRecord[]> {
    return this.audit.list(query);
  }
}

/** Mute every strip that can carry signal, mains included. */
function muteEverything(): DesiredValue[] {
  return allStrips().map((ref) => ({
    address: ref.capabilities.mix ? `${ref.root}/mix/on` : `${ref.root}/on`,
    // The console stores "on", and muted is its inverse.
    value: false,
  }));
}
