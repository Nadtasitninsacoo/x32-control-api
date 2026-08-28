import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { STRIP_COUNTS } from '../../osc/addresses/x32-addresses.js';
import {
  DYN_DETECTORS,
  DYN_ENVELOPES,
  DYN_MODES,
  DYN_POSITIONS,
  EQ_TYPES,
  GATE_MODES,
} from '../../osc/schema/x32-schema.js';
import {
  CHANNEL_COLORS,
  MAX_FADER_DB,
  MIN_FADER_DB,
} from '../../osc/units/x32-units.js';

/**
 * Partial updates, in engineering units.
 *
 * Ranges here are the console's real ranges: a value outside them is rejected
 * at the edge rather than silently clamped somewhere in the OSC layer, so an
 * operator finds out that +12 dB of EQ is not available before the show, not
 * during it.
 */

export class UpdateStripConfigDto {
  @ApiPropertyOptional({ example: 'Kick In', maxLength: 12 })
  @IsOptional()
  @IsString()
  @MaxLength(12)
  name?: string;

  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(74)
  icon?: number;

  @ApiPropertyOptional({ enum: CHANNEL_COLORS, example: 'GN' })
  @IsOptional()
  @IsIn([...CHANNEL_COLORS])
  color?: string;

  @ApiPropertyOptional({ example: 1, description: 'Input source index.' })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(168)
  source?: number;
}

export class UpdateStripMixDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  muted?: boolean;

  @ApiPropertyOptional({
    example: -6,
    minimum: MIN_FADER_DB,
    maximum: MAX_FADER_DB,
  })
  @IsOptional()
  @IsNumber()
  @Min(MIN_FADER_DB)
  @Max(MAX_FADER_DB)
  faderDb?: number;

  @ApiPropertyOptional({ example: -35, minimum: -100, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(-100)
  @Max(100)
  pan?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  stereo?: boolean;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  mono?: boolean;

  @ApiPropertyOptional({
    example: -10,
    minimum: MIN_FADER_DB,
    maximum: MAX_FADER_DB,
  })
  @IsOptional()
  @IsNumber()
  @Min(MIN_FADER_DB)
  @Max(MAX_FADER_DB)
  monoLevelDb?: number;
}

export class UpdateSendDto {
  @ApiPropertyOptional({
    example: 3,
    description: 'Destination bus or matrix number.',
  })
  @IsInt()
  @Min(1)
  @Max(STRIP_COUNTS.bus)
  to!: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  on?: boolean;

  @ApiPropertyOptional({
    example: -12,
    minimum: MIN_FADER_DB,
    maximum: MAX_FADER_DB,
  })
  @IsOptional()
  @IsNumber()
  @Min(MIN_FADER_DB)
  @Max(MAX_FADER_DB)
  levelDb?: number;

  @ApiPropertyOptional({ example: 0, minimum: -100, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(-100)
  @Max(100)
  pan?: number;
}

export class UpdatePreampDto {
  @ApiPropertyOptional({ example: 0, minimum: -18, maximum: 18 })
  @IsOptional()
  @IsNumber()
  @Min(-18)
  @Max(18)
  trimDb?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  invert?: boolean;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  lowCutOn?: boolean;

  @ApiPropertyOptional({ example: 80, minimum: 20, maximum: 400 })
  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(400)
  lowCutHz?: number;

  @ApiPropertyOptional({
    example: 24,
    minimum: -12,
    maximum: 60,
    description: 'Head amp gain. Channels on a local input only.',
  })
  @IsOptional()
  @IsNumber()
  @Min(-12)
  @Max(60)
  gainDb?: number;

  @ApiPropertyOptional({ example: false, description: '+48V phantom power.' })
  @IsOptional()
  @IsBoolean()
  phantom?: boolean;
}

export class UpdateGateDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  on?: boolean;

  @ApiPropertyOptional({ enum: GATE_MODES })
  @IsOptional()
  @IsIn([...GATE_MODES])
  mode?: string;

  @ApiPropertyOptional({ example: -40, minimum: -80, maximum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(-80)
  @Max(0)
  thresholdDb?: number;

  @ApiPropertyOptional({ example: 24, minimum: 3, maximum: 60 })
  @IsOptional()
  @IsNumber()
  @Min(3)
  @Max(60)
  rangeDb?: number;

  @ApiPropertyOptional({ example: 10, minimum: 0, maximum: 120 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(120)
  attackMs?: number;

  @ApiPropertyOptional({ example: 50, minimum: 0.02, maximum: 2000 })
  @IsOptional()
  @IsNumber()
  @Min(0.02)
  @Max(2000)
  holdMs?: number;

  @ApiPropertyOptional({ example: 250, minimum: 5, maximum: 4000 })
  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(4000)
  releaseMs?: number;
}

export class UpdateDynamicsDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  on?: boolean;

  @ApiPropertyOptional({ enum: DYN_MODES })
  @IsOptional()
  @IsIn([...DYN_MODES])
  mode?: string;

  @ApiPropertyOptional({ enum: DYN_DETECTORS })
  @IsOptional()
  @IsIn([...DYN_DETECTORS])
  detection?: string;

  @ApiPropertyOptional({ enum: DYN_ENVELOPES })
  @IsOptional()
  @IsIn([...DYN_ENVELOPES])
  envelope?: string;

  @ApiPropertyOptional({ example: -18, minimum: -60, maximum: 0 })
  @IsOptional()
  @IsNumber()
  @Min(-60)
  @Max(0)
  thresholdDb?: number;

  @ApiPropertyOptional({
    example: 4,
    minimum: 1.1,
    maximum: 100,
    description: 'Snapped to the nearest ratio the console offers.',
  })
  @IsOptional()
  @IsNumber()
  @Min(1.1)
  @Max(100)
  ratio?: number;

  @ApiPropertyOptional({ example: 2.5, minimum: 0, maximum: 5 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(5)
  knee?: number;

  @ApiPropertyOptional({ example: 3, minimum: 0, maximum: 24 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(24)
  makeupGainDb?: number;

  @ApiPropertyOptional({ example: 10, minimum: 0, maximum: 120 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(120)
  attackMs?: number;

  @ApiPropertyOptional({ example: 50, minimum: 0.02, maximum: 2000 })
  @IsOptional()
  @IsNumber()
  @Min(0.02)
  @Max(2000)
  holdMs?: number;

  @ApiPropertyOptional({ example: 150, minimum: 5, maximum: 4000 })
  @IsOptional()
  @IsNumber()
  @Min(5)
  @Max(4000)
  releaseMs?: number;

  @ApiPropertyOptional({ enum: DYN_POSITIONS })
  @IsOptional()
  @IsIn([...DYN_POSITIONS])
  position?: string;

  @ApiPropertyOptional({ example: 100, minimum: 0, maximum: 100 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  mixPercent?: number;
}

export class UpdateEqBandDto {
  @ApiPropertyOptional({ example: 2, description: 'Band number, 1-based.' })
  @IsInt()
  @Min(1)
  @Max(6)
  band!: number;

  @ApiPropertyOptional({ enum: EQ_TYPES })
  @IsOptional()
  @IsIn([...EQ_TYPES])
  type?: string;

  @ApiPropertyOptional({ example: 1000, minimum: 20, maximum: 20000 })
  @IsOptional()
  @IsNumber()
  @Min(20)
  @Max(20000)
  frequencyHz?: number;

  @ApiPropertyOptional({ example: -4.5, minimum: -15, maximum: 15 })
  @IsOptional()
  @IsNumber()
  @Min(-15)
  @Max(15)
  gainDb?: number;

  @ApiPropertyOptional({ example: 2, minimum: 0.3, maximum: 10 })
  @IsOptional()
  @IsNumber()
  @Min(0.3)
  @Max(10)
  q?: number;
}

export class UpdateEqDto {
  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  on?: boolean;

  @ApiPropertyOptional({ type: [UpdateEqBandDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(6)
  @ValidateNested({ each: true })
  @Type(() => UpdateEqBandDto)
  bands?: UpdateEqBandDto[];
}

export class UpdateStripDto {
  @ApiPropertyOptional({ type: UpdateStripConfigDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateStripConfigDto)
  config?: UpdateStripConfigDto;

  @ApiPropertyOptional({ type: UpdateStripMixDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateStripMixDto)
  mix?: UpdateStripMixDto;

  @ApiPropertyOptional({ type: [UpdateSendDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(STRIP_COUNTS.bus)
  @ValidateNested({ each: true })
  @Type(() => UpdateSendDto)
  sends?: UpdateSendDto[];

  @ApiPropertyOptional({ type: UpdatePreampDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdatePreampDto)
  preamp?: UpdatePreampDto;

  @ApiPropertyOptional({ type: UpdateGateDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateGateDto)
  gate?: UpdateGateDto;

  @ApiPropertyOptional({ type: UpdateDynamicsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateDynamicsDto)
  dynamics?: UpdateDynamicsDto;

  @ApiPropertyOptional({ type: UpdateEqDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => UpdateEqDto)
  eq?: UpdateEqDto;
}
