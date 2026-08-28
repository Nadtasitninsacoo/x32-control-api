import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

export class SafetyStatusDto {
  @ApiProperty({
    example: false,
    description:
      'State-changing OSC is logged instead of sent. Set with DRY_RUN.',
  })
  dryRun!: boolean;

  @ApiProperty({
    example: false,
    description: 'Writes are refused with 423 Locked.',
  })
  readOnly!: boolean;

  @ApiPropertyOptional({ example: 'guest engineer driving' })
  readOnlyReason?: string;

  @ApiProperty({ example: false })
  authEnabled!: boolean;

  @ApiProperty({
    enum: ['memory', 'postgres'],
    example: 'memory',
    description:
      'Where the audit trail goes. In memory, it does not survive a restart.',
  })
  auditStorage!: string;

  @ApiProperty({
    type: [String],
    example: ['default'],
    description:
      'Consoles that have a safe state captured and can be recovered by PANIC.',
  })
  consolesWithSafeState!: string[];
}

export class SetReadOnlyDto {
  @ApiProperty({ example: true })
  @IsBoolean()
  enabled!: boolean;

  @ApiPropertyOptional({
    example: 'guest engineer driving',
    description: 'Shown to anyone whose write is refused.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  reason?: string;
}

export class CaptureSafeStateDto {
  @ApiProperty({ example: 'default' })
  @IsString()
  consoleId!: string;
}

export class PanicDto {
  @ApiProperty({ example: 'default' })
  @IsString()
  consoleId!: string;

  @ApiPropertyOptional({
    enum: ['safe-state', 'mute-all'],
    default: 'safe-state',
    description:
      '`safe-state` restores what was captured as safe; `mute-all` mutes every strip, which ' +
      'needs nothing captured beforehand.',
  })
  @IsOptional()
  @IsIn(['safe-state', 'mute-all'])
  mode?: string;
}

export class AuditEntryDto {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  at!: Date;

  @ApiPropertyOptional({ example: 'sam' })
  user?: string | null;

  @ApiProperty({ example: 'PATCH /api/consoles/default/strips/ch/1' })
  action!: string;

  @ApiPropertyOptional({ example: 'default' })
  consoleId?: string | null;

  @ApiPropertyOptional({
    example: { mix: '{"faderDb":-6}', outcome: { changed: 1, messages: 1 } },
    description:
      'Request summary and what it changed. Secrets are redacted, bulk is elided.',
  })
  detail?: Record<string, unknown> | null;
}

export class AuditQueryDto {
  @ApiPropertyOptional({ example: 100, default: 100 })
  @IsOptional()
  // Query strings arrive as strings; without this the validator sees "50".
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(1000)
  limit?: number;

  @ApiPropertyOptional({ example: 'default' })
  @IsOptional()
  @IsString()
  consoleId?: string;

  @ApiPropertyOptional({ example: 'sam' })
  @IsOptional()
  @IsString()
  user?: string;
}
