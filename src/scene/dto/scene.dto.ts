import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import { SCENE_SLOTS } from '../scene.service.js';

export class ShowSlotDto {
  @ApiProperty({ example: 3 })
  index!: number;

  @ApiProperty({ example: 'Rock Night' })
  name!: string;

  @ApiPropertyOptional({ example: 'FOH base, no support act' })
  note?: string;
}

export class RecallSlotDto {
  @ApiProperty({ example: 3, minimum: 0, maximum: SCENE_SLOTS - 1 })
  @IsInt()
  @Min(0)
  @Max(SCENE_SLOTS - 1)
  index!: number;
}

export class SaveSceneDto {
  @ApiProperty({ example: 3, minimum: 0, maximum: SCENE_SLOTS - 1 })
  @IsInt()
  @Min(0)
  @Max(SCENE_SLOTS - 1)
  index!: number;

  @ApiProperty({ example: 'Rock Night' })
  @IsString()
  @MaxLength(24)
  name!: string;

  @ApiPropertyOptional({ example: 'After soundcheck' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  note?: string;

  @ApiProperty({
    example: 'OVERWRITE',
    description:
      'Must be "OVERWRITE". Saving replaces whatever is in that slot.',
  })
  @IsString()
  confirm!: string;
}

export class ImportScnDto {
  @ApiProperty({ description: 'The contents of a .scn file.' })
  @IsString()
  content!: string;

  @ApiPropertyOptional({
    example: false,
    description:
      'Send it to the console. Without this the request only reports what it would do.',
  })
  @IsOptional()
  @IsBoolean()
  apply?: boolean;

  @ApiPropertyOptional({
    example: 400,
    description: 'Ramp time for level changes, in ms.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(5000)
  rampMs?: number;

  @ApiPropertyOptional({
    example: 'OVERWRITE',
    description: 'Required when apply is true.',
  })
  @IsOptional()
  @IsString()
  confirm?: string;
}

export class ValueChangeDto {
  @ApiProperty({ example: '/ch/01/mix/fader' })
  address!: string;

  @ApiPropertyOptional({ example: -90 })
  from?: unknown;

  @ApiProperty({ example: -6 })
  to!: unknown;

  @ApiProperty({
    example: true,
    description: 'Whether this value was ramped rather than jumped.',
  })
  ramped!: boolean;
}

export class ApplyReportDto {
  @ApiProperty({ example: 812 })
  requested!: number;

  @ApiProperty({
    example: 37,
    description: 'Values that actually differed and were sent.',
  })
  changed!: number;

  @ApiProperty({ example: 775, description: 'Values the console already had.' })
  unchanged!: number;

  @ApiProperty({
    type: [String],
    example: [],
    description: 'Addresses with no schema.',
  })
  unknown!: string[];

  @ApiProperty({ example: 12 })
  rampedFaders!: number;

  @ApiProperty({ example: 8 })
  stepsPerFader!: number;

  @ApiProperty({ example: 133, description: 'Datagrams sent.' })
  messages!: number;

  @ApiProperty({ example: 412 })
  durationMs!: number;

  @ApiProperty({ type: [ValueChangeDto] })
  changes!: ValueChangeDto[];
}

export class ImportReportDto {
  @ApiProperty({ example: 'Rock Night' })
  name!: string;

  @ApiProperty({ example: 'FOH base' })
  note!: string;

  @ApiProperty({ example: '2.7' })
  version!: string;

  @ApiProperty({ example: 812 })
  parsedValues!: number;

  @ApiProperty({
    example: 40,
    description:
      'Lines this project has no schema for — routing, effects, and the like.',
  })
  unknownLines!: number;

  @ApiProperty({
    type: [String],
    example: [],
    description:
      'Lines whose value count disagreed with the schema. These are never decoded by ' +
      'position, because every value after a mismatch would land on the wrong parameter.',
  })
  rejectedLines!: string[];

  @ApiProperty({ example: false })
  applied!: boolean;

  @ApiPropertyOptional({ type: ApplyReportDto })
  apply?: ApplyReportDto;
}
