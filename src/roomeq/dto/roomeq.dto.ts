import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { DEFAULTS } from '../dsp/peq-fitter.js';

export class FitSettingsDto {
  @ApiPropertyOptional({
    example: 6,
    minimum: 1,
    maximum: 6,
    description:
      'Bands to use. Defaults to however many the destination strip has.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(6)
  bands?: number;

  @ApiPropertyOptional({
    example: DEFAULTS.minHz,
    description:
      'Bottom of the correction range. Below this the fix is the room, not EQ.',
  })
  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(1000)
  minHz?: number;

  @ApiPropertyOptional({
    example: DEFAULTS.maxHz,
    description:
      'Top of the correction range. Above this it is air and directivity.',
  })
  @IsOptional()
  @IsNumber()
  @Min(1000)
  @Max(20000)
  maxHz?: number;

  @ApiPropertyOptional({
    example: DEFAULTS.smoothingOctaveFraction,
    description: '6 means 1/6 octave. Smaller numbers smooth harder.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(24)
  smoothingOctaveFraction?: number;

  @ApiPropertyOptional({
    example: DEFAULTS.maxBoostDb,
    description:
      'Boost ceiling. Boosting spends headroom on the loudest thing in the room.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(15)
  maxBoostDb?: number;

  @ApiPropertyOptional({
    example: DEFAULTS.maxCutDb,
    description: 'Cut limit.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(15)
  maxCutDb?: number;

  @ApiPropertyOptional({
    example: DEFAULTS.toleranceDb,
    description: 'Stop fitting once nothing is left above this deviation.',
  })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(12)
  toleranceDb?: number;

  @ApiPropertyOptional({
    example: 0,
    description:
      'House curve tilt in dB per octave around 1 kHz. Negative is darker.',
  })
  @IsOptional()
  @IsNumber()
  @Min(-3)
  @Max(3)
  tiltDbPerOctave?: number;
}

export class AnalyzeRoomEqDto extends FitSettingsDto {
  @ApiProperty({
    description:
      'Contents of a REW text export or a CSV of frequency and level.',
    example: '* REW V5.20\n20.000 78.4\n25.198 79.1\n…',
  })
  @IsString()
  @MaxLength(4_000_000)
  measurement!: string;
}

export class PeqBandDto {
  @ApiProperty({ example: 1 })
  band!: number;

  @ApiProperty({ example: 163.2 })
  frequencyHz!: number;

  @ApiProperty({ example: -4.5 })
  gainDb!: number;

  @ApiProperty({ example: 3.2 })
  q!: number;
}

export class RoomEqCurvesDto {
  @ApiProperty({
    type: [Number],
    description: 'Log-spaced frequency axis, in Hz.',
  })
  frequencies!: number[];

  @ApiProperty({
    type: [Number],
    description: 'Smoothed measurement, normalised to its average.',
  })
  before!: number[];

  @ApiProperty({
    type: [Number],
    description: 'The same measurement with the filters applied.',
  })
  after!: number[];

  @ApiProperty({ type: [Number], description: 'The curve being aimed at.' })
  target!: number[];
}

export class RoomEqAnalysisDto {
  @ApiProperty({ type: [PeqBandDto] })
  bands!: PeqBandDto[];

  @ApiProperty({
    type: RoomEqCurvesDto,
    description: 'Everything a plot needs.',
  })
  curves!: RoomEqCurvesDto;

  @ApiProperty({
    example: 4.21,
    description: 'Standard deviation from target before, in dB.',
  })
  deviationBeforeDb!: number;

  @ApiProperty({ example: 1.63, description: 'And after.' })
  deviationAfterDb!: number;

  @ApiProperty({
    example: 412,
    description: 'Points read from the measurement.',
  })
  measurementPoints!: number;

  @ApiProperty({
    example: 20,
    description: 'Lowest frequency the measurement covers.',
  })
  measurementMinHz!: number;

  @ApiProperty({ example: 20000 })
  measurementMaxHz!: number;

  @ApiProperty({
    type: [String],
    description: 'Header lines from the measurement file.',
  })
  notes!: string[];

  @ApiProperty({
    type: [String],
    example: [],
    description: 'Things worth telling the operator before they press apply.',
  })
  warnings!: string[];
}

/**
 * A band on the way *in*. Separate from the response shape on purpose: values
 * arriving from a client are validated against what the console can be set to,
 * and a nested object with no validators would be stripped by the whitelist.
 */
export class PeqBandInputDto {
  @ApiProperty({ example: 1, minimum: 1, maximum: 6 })
  @IsInt()
  @Min(1)
  @Max(6)
  band!: number;

  @ApiProperty({ example: 163.2, minimum: 20, maximum: 20000 })
  @IsNumber()
  @Min(20)
  @Max(20000)
  frequencyHz!: number;

  @ApiProperty({ example: -4.5, minimum: -15, maximum: 15 })
  @IsNumber()
  @Min(-15)
  @Max(15)
  gainDb!: number;

  @ApiProperty({ example: 3.2, minimum: 0.3, maximum: 10 })
  @IsNumber()
  @Min(0.3)
  @Max(10)
  q!: number;
}

export class ApplyRoomEqDto extends FitSettingsDto {
  @ApiProperty({
    example: 'bus/01',
    description: 'Strip to correct: `bus/01`, `main/st`, `ch/01` …',
  })
  @IsString()
  strip!: string;

  @ApiPropertyOptional({
    description: 'A measurement to fit. Give this or `bands`, not neither.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4_000_000)
  measurement?: string;

  @ApiPropertyOptional({
    type: [PeqBandInputDto],
    description:
      'Explicit bands, e.g. ones a previous analysis returned and the operator edited.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => PeqBandInputDto)
  bandValues?: PeqBandInputDto[];

  @ApiPropertyOptional({
    example: true,
    default: true,
    description:
      'Flatten the bands the correction does not use. Without this, an older correction ' +
      'stays half-applied underneath the new one.',
  })
  @IsOptional()
  @IsBoolean()
  flattenUnusedBands?: boolean;

  @ApiPropertyOptional({
    example: true,
    default: true,
    description: 'Switch the EQ on as part of applying it.',
  })
  @IsOptional()
  @IsBoolean()
  enableEq?: boolean;
}
