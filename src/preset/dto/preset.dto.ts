import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { STRIP_COUNTS } from '../../osc/addresses/x32-addresses.js';
import { CHANNEL_COLORS } from '../../osc/units/x32-units.js';
import { ALL_SECTIONS } from '../preset.service.js';
import type { PresetSection } from '../preset.service.js';

export class VenueDto {
  @ApiProperty({ example: 'b3f2…' })
  id!: string;

  @ApiProperty({ example: 'The Old Hall' })
  name!: string;

  @ApiPropertyOptional({ example: '800 cap, concrete rear wall' })
  roomSize?: string | null;

  @ApiPropertyOptional({
    example: 'Rings at 160 Hz. Keep the subs off the wall.',
  })
  notes?: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class InputListEntryDto {
  @ApiProperty({ example: 1, minimum: 1, maximum: STRIP_COUNTS.ch })
  @IsInt()
  @Min(1)
  @Max(STRIP_COUNTS.ch)
  input!: number;

  @ApiProperty({ example: 'Kick In', maxLength: 12 })
  @IsString()
  @MaxLength(12)
  name!: string;

  @ApiPropertyOptional({ enum: CHANNEL_COLORS, example: 'GN' })
  @IsOptional()
  @IsIn([...CHANNEL_COLORS])
  color?: string;

  @ApiPropertyOptional({
    example: 24,
    minimum: -12,
    maximum: 60,
    description: 'Head amp gain.',
  })
  @IsOptional()
  @IsNumber()
  @Min(-12)
  @Max(60)
  gainDb?: number;

  @ApiPropertyOptional({ example: false })
  @IsOptional()
  @IsBoolean()
  phantom?: boolean;

  @ApiPropertyOptional({ example: 'Beta 91A, inside the drum' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  notes?: string;
}

export class BandDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'The Loud Ones' })
  name!: string;

  @ApiPropertyOptional({ example: 'Guitarist brings his own wedge mix' })
  notes?: string | null;

  @ApiPropertyOptional({ type: [InputListEntryDto] })
  inputList?: InputListEntryDto[] | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class CreateVenueDto {
  @ApiProperty({ example: 'The Old Hall' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: '800 cap, concrete rear wall' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  roomSize?: string;

  @ApiPropertyOptional({ example: 'Rings at 160 Hz.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;
}

export class UpdateVenueDto extends CreateVenueDto {
  @ApiPropertyOptional({ example: 'The Old Hall' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  declare name: string;
}

export class CreateBandDto {
  @ApiProperty({ example: 'The Loud Ones' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Two guitars, in-ears' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  notes?: string;

  @ApiPropertyOptional({ type: [InputListEntryDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(STRIP_COUNTS.ch)
  @ValidateNested({ each: true })
  @Type(() => InputListEntryDto)
  inputList?: InputListEntryDto[];
}

export class UpdateBandDto extends CreateBandDto {
  @ApiPropertyOptional({ example: 'The Loud Ones' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  declare name: string;
}

export class CaptureOptionsDto {
  @ApiPropertyOptional({
    type: [String],
    example: ['ch/01', 'ch/02'],
    description: 'Strips to capture. Default: every strip on the console.',
  })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  strips?: string[];

  @ApiPropertyOptional({
    isArray: true,
    enum: ALL_SECTIONS,
    example: ['config', 'mix'],
    description: 'Parts of each strip to capture. Default: all of them.',
  })
  @IsOptional()
  @IsArray()
  @IsIn(ALL_SECTIONS, { each: true })
  sections?: PresetSection[];
}

export class CreatePresetDto {
  @ApiProperty({ example: 'Rock Night — FOH' })
  @IsString()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ example: 'Base mix before the support act' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Venue this preset belongs to.' })
  @IsOptional()
  @IsString()
  venueId?: string;

  @ApiPropertyOptional({ description: 'Band this preset belongs to.' })
  @IsOptional()
  @IsString()
  bandId?: string;

  @ApiPropertyOptional({
    example: 'default',
    description: 'Console to capture from. Ignored when `values` is given.',
  })
  @IsOptional()
  @IsString()
  consoleId?: string;

  @ApiPropertyOptional({ type: CaptureOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CaptureOptionsDto)
  capture?: CaptureOptionsDto;

  @ApiPropertyOptional({
    description: 'Explicit values, instead of capturing from a console.',
    example: { '/ch/01/mix/fader': -6 },
  })
  @IsOptional()
  @IsObject()
  values?: Record<string, string | number | boolean>;

  @ApiPropertyOptional({ example: 'After soundcheck' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class CaptureVersionDto {
  @ApiPropertyOptional({ example: 'default' })
  @IsOptional()
  @IsString()
  consoleId?: string;

  @ApiPropertyOptional({ type: CaptureOptionsDto })
  @IsOptional()
  @ValidateNested()
  @Type(() => CaptureOptionsDto)
  capture?: CaptureOptionsDto;

  @ApiPropertyOptional({ example: { '/ch/01/mix/fader': -6 } })
  @IsOptional()
  @IsObject()
  values?: Record<string, string | number | boolean>;

  @ApiPropertyOptional({ example: 'Louder for the headline set' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class ApplyPresetDto {
  @ApiProperty({ example: 'default', description: 'Console to apply to.' })
  @IsString()
  consoleId!: string;

  @ApiPropertyOptional({
    example: 3,
    description: 'Version to apply. Default: the current one.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  version?: number;

  @ApiPropertyOptional({
    example: 400,
    description:
      'Ramp time for level changes, clamped to the configured window.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5000)
  rampMs?: number;

  @ApiPropertyOptional({
    example: false,
    description:
      'Skip ramping. For a panic recall, where speed beats smoothness.',
  })
  @IsOptional()
  @IsBoolean()
  immediate?: boolean;
}

export class ApplyInputListDto {
  @ApiProperty({ example: 'default' })
  @IsString()
  consoleId!: string;

  @ApiPropertyOptional({ example: 400 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5000)
  rampMs?: number;
}

export class RollbackDto {
  @ApiProperty({ example: 2, description: 'Version to make current again.' })
  @IsInt()
  @Min(1)
  version!: number;
}

export class PresetDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ example: 'Rock Night — FOH' })
  name!: string;

  @ApiPropertyOptional()
  description?: string | null;

  @ApiPropertyOptional()
  venueId?: string | null;

  @ApiPropertyOptional()
  bandId?: string | null;

  @ApiProperty({
    example: 3,
    description: 'Version currently considered the head.',
  })
  version!: number;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class PresetVersionDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  presetId!: string;

  @ApiProperty({ example: 3 })
  version!: number;

  @ApiProperty({
    example: { '/ch/01/mix/fader': -6, '/ch/01/config/name': 'Kick In' },
    description: 'Parameter address -> value in API units.',
  })
  values!: Record<string, string | number | boolean>;

  @ApiPropertyOptional({ example: 'After soundcheck' })
  note?: string | null;

  @ApiPropertyOptional({ example: 'sam' })
  createdBy?: string | null;

  @ApiProperty()
  createdAt!: Date;
}

export class PresetPreviewDto {
  @ApiProperty({
    example: [{ address: '/ch/01/mix/fader', from: -12, to: -6, ramped: true }],
    description: 'What would change, and which of those would be ramped.',
  })
  changes!: unknown[];

  @ApiProperty({
    example: 741,
    description: 'Values the console already matches.',
  })
  unchanged!: number;

  @ApiProperty({
    type: [String],
    example: [],
    description: 'Stored addresses this build has no schema for.',
  })
  unknown!: string[];
}
