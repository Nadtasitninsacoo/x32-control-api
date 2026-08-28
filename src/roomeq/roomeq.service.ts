import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import {
  ApplyReport,
  ApplyService,
  DesiredValue,
} from '../apply/apply.service.js';
import { ConsoleManagerService } from '../console/console-manager.service.js';
import { resolveStrip } from '../mixer/strip-ref.js';
import {
  Measurement,
  MeasurementParseError,
  parseMeasurement,
} from './measurement/measurement-parser.js';
import { FitOptions, FitResult, PeqBand, fitPeq } from './dsp/peq-fitter.js';

/**
 * Room correction: measurement in, PEQ bands out, and onto a bus if asked.
 *
 * Analysis is deliberately stateless — a measurement is a file the operator
 * already has, and nothing here needs to be stored to be useful. What does get
 * stored is the result, if they save it as a venue preset.
 *
 * Only the console's own parametric EQ is written. The 31-band graphic EQ lives
 * in an effects slot whose addressing this project does not model, and guessing
 * at it would mean writing to whatever effect happens to be loaded.
 */

export interface RoomEqAnalysis extends FitResult {
  readonly measurementPoints: number;
  readonly measurementMinHz: number;
  readonly measurementMaxHz: number;
  readonly notes: readonly string[];
  /** Things worth saying out loud before anybody presses apply. */
  readonly warnings: readonly string[];
}

export interface ApplyRoomEqResult {
  readonly strip: string;
  readonly bands: readonly PeqBand[];
  readonly analysis?: RoomEqAnalysis;
  readonly apply: ApplyReport;
}

@Injectable()
export class RoomEqService {
  private readonly logger = new Logger(RoomEqService.name);

  constructor(
    private readonly consoles: ConsoleManagerService,
    private readonly apply: ApplyService,
  ) {}

  /** Parses a measurement and fits a correction to it. Touches no console. */
  analyze(measurementText: string, options: FitOptions): RoomEqAnalysis {
    let measurement: Measurement;
    try {
      measurement = parseMeasurement(measurementText);
    } catch (error) {
      if (error instanceof MeasurementParseError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }

    const fit = fitPeq(measurement.points, options);

    return {
      ...fit,
      measurementPoints: measurement.points.length,
      measurementMinHz: measurement.minHz,
      measurementMaxHz: measurement.maxHz,
      notes: measurement.notes,
      warnings: warningsFor(measurement, fit, options),
    };
  }

  /**
   * Writes a correction to a strip's EQ.
   *
   * Bands the correction does not use are flattened by default: leaving an
   * older correction half in place underneath a new one is how a system ends up
   * EQ'd twice for a room it is only in once.
   */
  async applyToStrip(
    consoleId: string,
    stripId: string,
    input: {
      measurement?: string;
      bands?: readonly PeqBand[];
      fit?: Partial<FitOptions>;
      flattenUnusedBands?: boolean;
      enableEq?: boolean;
    },
  ): Promise<ApplyRoomEqResult> {
    const connection = this.consoles.require(consoleId);
    const ref = resolveStrip(...splitStripId(stripId));

    if (ref.capabilities.eqBands === 0) {
      throw new BadRequestException(`${ref.id} has no EQ to correct`);
    }

    const bandCount = Math.min(
      input.fit?.bands ?? ref.capabilities.eqBands,
      ref.capabilities.eqBands,
    );

    let analysis: RoomEqAnalysis | undefined;
    let bands: readonly PeqBand[];

    if (input.bands && input.bands.length > 0) {
      bands = input.bands;
    } else if (input.measurement) {
      analysis = this.analyze(input.measurement, {
        ...input.fit,
        bands: bandCount,
      });
      bands = analysis.bands;
    } else {
      throw new BadRequestException(
        'give either a measurement to fit or explicit bands',
      );
    }

    for (const band of bands) {
      if (band.band < 1 || band.band > ref.capabilities.eqBands) {
        throw new BadRequestException(
          `${ref.id} has ${ref.capabilities.eqBands} EQ bands, not band ${band.band}`,
        );
      }
    }

    const desired: DesiredValue[] = [];
    if (input.enableEq !== false)
      desired.push({ address: `${ref.root}/eq/on`, value: true });

    for (const band of bands) {
      const root = `${ref.root}/eq/${band.band}`;
      desired.push(
        { address: `${root}/type`, value: 'PEQ' },
        { address: `${root}/f`, value: band.frequencyHz },
        { address: `${root}/g`, value: band.gainDb },
        { address: `${root}/q`, value: band.q },
      );
    }

    if (input.flattenUnusedBands !== false) {
      const used = new Set(bands.map((band) => band.band));
      for (let band = 1; band <= ref.capabilities.eqBands; band += 1) {
        if (used.has(band)) continue;
        desired.push({ address: `${ref.root}/eq/${band}/g`, value: 0 });
      }
    }

    const report = await this.apply.apply(connection, desired);
    this.logger.log(
      `${consoleId}: room EQ written to ${ref.id} — ${bands.length} band(s), ` +
        `${report.changed} parameter(s) changed`,
    );

    return { strip: ref.id, bands, analysis, apply: report };
  }
}

function splitStripId(stripId: string): [string, string] {
  const [kind, index] = stripId.split('/');
  if (!kind || !index) {
    throw new BadRequestException(
      `strip must look like "bus/01" or "main/st", got "${stripId}"`,
    );
  }
  return [kind, index];
}

/**
 * The things an operator would want mentioned before they trust a correction.
 * Silence here is a claim, so each of these is worth the words.
 */
function warningsFor(
  measurement: Measurement,
  fit: FitResult,
  options: FitOptions,
): string[] {
  const warnings: string[] = [];
  const minHz = options.minHz ?? 40;
  const maxHz = options.maxHz ?? 8000;

  if (measurement.minHz > minHz) {
    warnings.push(
      `the measurement starts at ${Math.round(measurement.minHz)} Hz, above the ` +
        `${minHz} Hz correction range — nothing below that was corrected`,
    );
  }
  if (measurement.maxHz < maxHz) {
    warnings.push(
      `the measurement stops at ${Math.round(measurement.maxHz)} Hz, below the ` +
        `${maxHz} Hz correction range`,
    );
  }
  if (measurement.points.length < 100) {
    warnings.push(
      `only ${measurement.points.length} points in the measurement — a sparse sweep hides ` +
        `the resonances this is meant to find`,
    );
  }
  if (fit.bands.length === 0) {
    warnings.push(
      'nothing to correct: the response is already within tolerance of the target',
    );
  }
  if (
    fit.bands.some((band) => band.gainDb >= (options.maxBoostDb ?? 6) - 0.05)
  ) {
    warnings.push(
      'a band hit the boost ceiling — the dip it is filling is deeper than EQ should fix. ' +
        'Check placement and the room before turning the ceiling up',
    );
  }
  if (fit.deviationAfterDb > fit.deviationBeforeDb) {
    warnings.push(
      'the correction did not improve the deviation; treat this measurement with suspicion',
    );
  }
  return warnings;
}
