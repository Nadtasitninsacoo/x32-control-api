import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ConsoleManagerService } from './console-manager.service.js';
import type { ConsoleStatus, SyncDepth } from './console.types.js';
import { ConsoleDiscoveryService } from './discovery/console-discovery.service.js';
import {
  ConnectConsoleDto,
  ConsoleInfoDto,
  ConsoleStatusDto,
  DiscoverConsolesDto,
  DiscoveredConsoleDto,
  SyncReportDto,
} from './dto/console.dto.js';

function toStatusDto(status: ConsoleStatus): ConsoleStatusDto {
  return {
    id: status.id,
    state: status.state,
    host: status.endpoint.host,
    port: status.endpoint.port,
    info: status.info,
    cachedAddresses: status.cachedAddresses,
    lastSyncAt: status.lastSyncAt,
    lastFeedAt: status.lastFeedAt,
    missedProbes: status.missedProbes,
    reconnectAttempts: status.reconnectAttempts,
    dryRun: status.dryRun,
  };
}

@ApiTags('consoles')
@Controller('consoles')
export class ConsoleController {
  constructor(
    private readonly consoles: ConsoleManagerService,
    private readonly discovery: ConsoleDiscoveryService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List the consoles this API is managing' })
  @ApiOkResponse({ type: [ConsoleStatusDto] })
  list(): ConsoleStatusDto[] {
    return this.consoles.list().map(toStatusDto);
  }

  @Post('discover')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Find consoles on the network',
    description:
      'Broadcasts `/info` and collects whoever answers. Broadcast does not cross a Docker ' +
      'bridge network or most VPNs — set the console address explicitly when it does not.',
  })
  @ApiOkResponse({ type: [DiscoveredConsoleDto] })
  discover(
    @Body() options: DiscoverConsolesDto,
  ): Promise<DiscoveredConsoleDto[]> {
    return this.discovery.discover(options);
  }

  @Post()
  @ApiOperation({
    summary: 'Connect to a console',
    description:
      'Opens the link, identifies the console and starts mirroring its state. The surface ' +
      'of the mirror is filled before this returns; the rest streams in behind it.',
  })
  @ApiCreatedResponse({ type: ConsoleInfoDto })
  @ApiConflictResponse({
    description: 'A console is already connected under this id.',
  })
  @ApiServiceUnavailableResponse({ description: 'The console did not answer.' })
  connect(@Body() body: ConnectConsoleDto): Promise<ConsoleInfoDto> {
    return this.consoles.connect(body);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Status of one console' })
  @ApiOkResponse({ type: ConsoleStatusDto })
  @ApiNotFoundResponse({ description: 'No console with this id.' })
  status(@Param('id') id: string): ConsoleStatusDto {
    return toStatusDto(this.consoles.require(id).status());
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Disconnect a console',
    description:
      'Closes the link and drops its mirror. The console itself is untouched.',
  })
  @ApiNoContentResponse()
  async disconnect(@Param('id') id: string): Promise<void> {
    await this.consoles.disconnect(id);
  }

  @Post(':id/resync')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Re-read the console into the mirror',
    description:
      'Rarely needed — the parameter feed keeps the mirror current on its own. Useful after ' +
      'a scene recall on the surface, or to check whether this firmware prints `/node` the ' +
      'way the schema expects.',
  })
  @ApiQuery({
    name: 'depth',
    enum: ['surface', 'sends', 'full'],
    required: false,
  })
  @ApiOkResponse({ type: SyncReportDto })
  @ApiNotFoundResponse({ description: 'No console with this id.' })
  async resync(
    @Param('id') id: string,
    @Query('depth') depth?: SyncDepth,
  ): Promise<SyncReportDto> {
    const report = await this.consoles.require(id).sync(depth ?? 'surface');
    return { ...report, unparsed: [...report.unparsed] };
  }

  @Get(':id/state')
  @ApiOperation({
    summary: 'Raw contents of the state mirror',
    description:
      'Every mirrored address under a prefix, in API units. A troubleshooting view — the ' +
      'strip endpoints are the ones to build on.',
  })
  @ApiQuery({ name: 'prefix', required: false, example: '/ch/01' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      additionalProperties: true,
      example: { '/ch/01/mix/fader': -6 },
    },
  })
  state(
    @Param('id') id: string,
    @Query('prefix') prefix?: string,
  ): Record<string, unknown> {
    return this.consoles.require(id).cache.snapshot(prefix ?? '/');
  }
}
