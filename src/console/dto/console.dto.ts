import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
} from 'class-validator';

export class ConsoleInfoDto {
  @ApiProperty({ example: '192.168.1.10' })
  host!: string;

  @ApiProperty({ example: 10023 })
  port!: number;

  @ApiProperty({ example: 'V2.07', description: 'OSC server version.' })
  serverVersion!: string;

  @ApiProperty({ example: 'FOH-X32' })
  name!: string;

  @ApiProperty({ example: 'X32', description: 'X32, X32C, M32, …' })
  model!: string;

  @ApiProperty({ example: '4.06' })
  firmware!: string;
}

export class DiscoveredConsoleDto extends ConsoleInfoDto {
  @ApiProperty({
    example: 12,
    description: 'How long the console took to answer, in ms.',
  })
  rttMs!: number;
}

export class ConsoleStatusDto {
  @ApiProperty({ example: 'default' })
  id!: string;

  @ApiProperty({
    enum: [
      'disconnected',
      'connecting',
      'syncing',
      'connected',
      'reconnecting',
    ],
    example: 'connected',
  })
  state!: string;

  @ApiProperty({ example: '192.168.1.10' })
  host!: string;

  @ApiProperty({ example: 10023 })
  port!: number;

  @ApiPropertyOptional({ type: ConsoleInfoDto })
  info?: ConsoleInfoDto;

  @ApiProperty({ example: 1247, description: 'Parameters currently mirrored.' })
  cachedAddresses!: number;

  @ApiPropertyOptional({
    example: 1738000000000,
    description: 'Epoch ms of the last full sync.',
  })
  lastSyncAt?: number;

  @ApiPropertyOptional({
    example: 1738000004000,
    description: 'Epoch ms of the last message from the parameter feed.',
  })
  lastFeedAt?: number;

  @ApiProperty({
    example: 0,
    description: 'Consecutive unanswered liveness probes.',
  })
  missedProbes!: number;

  @ApiProperty({ example: 0 })
  reconnectAttempts!: number;

  @ApiProperty({
    example: false,
    description: 'When true, state-changing OSC is logged instead of sent.',
  })
  dryRun!: boolean;
}

export class ConnectConsoleDto {
  @ApiProperty({
    example: '192.168.1.10',
    description: 'Console IP address or hostname.',
  })
  @IsString()
  @Matches(/^[a-zA-Z0-9.\-_]+$/, {
    message: 'host must be an IP address or hostname',
  })
  host!: string;

  @ApiPropertyOptional({ example: 10023, default: 10023 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({
    example: 'foh',
    description:
      'Id to address this console by. Defaults to "default" for the first one.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[a-zA-Z0-9\-_]{1,32}$/, {
    message: 'id may contain letters, numbers, dashes and underscores',
  })
  id?: string;
}

export class DiscoverConsolesDto {
  @ApiPropertyOptional({
    example: '255.255.255.255',
    description: 'Where to send the probe. Defaults to OSC_BROADCAST_ADDRESS.',
  })
  @IsOptional()
  @IsString()
  address?: string;

  @ApiPropertyOptional({ example: 10023 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(65535)
  port?: number;

  @ApiPropertyOptional({
    example: 1500,
    description: 'How long to listen for answers, in ms.',
  })
  @IsOptional()
  @IsInt()
  @Min(100)
  @Max(30000)
  timeoutMs?: number;
}

export class SyncReportDto {
  @ApiProperty({ enum: ['surface', 'sends', 'full'], example: 'surface' })
  depth!: string;

  @ApiProperty({ example: 160 })
  queries!: number;

  @ApiProperty({
    example: 812,
    description: 'Parameters written into the mirror.',
  })
  applied!: number;

  @ApiProperty({
    type: [String],
    example: [],
    description:
      'Containers whose dump did not match the schema and were re-read one parameter ' +
      'at a time. A non-empty list means this firmware prints a container differently ' +
      'than expected — worth reporting.',
  })
  unparsed!: string[];

  @ApiProperty({ example: 0 })
  fallbackReads!: number;

  @ApiProperty({
    example: 0,
    description: 'Queries the console never answered.',
  })
  failed!: number;

  @ApiProperty({ example: 3120 })
  durationMs!: number;
}
