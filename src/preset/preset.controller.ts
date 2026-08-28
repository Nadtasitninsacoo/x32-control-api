import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
  ApiTags,
} from '@nestjs/swagger';
import { ApplyReportDto } from '../scene/dto/scene.dto.js';
import {
  ApplyInputListDto,
  ApplyPresetDto,
  BandDto,
  CaptureVersionDto,
  CreateBandDto,
  CreatePresetDto,
  CreateVenueDto,
  PresetDto,
  PresetPreviewDto,
  PresetVersionDto,
  RollbackDto,
  UpdateBandDto,
  UpdateVenueDto,
  VenueDto,
} from './dto/preset.dto.js';
import { PresetService } from './preset.service.js';

@ApiTags('venues')
@Controller('venues')
export class VenueController {
  constructor(private readonly presets: PresetService) {}

  @Get()
  @ApiOperation({ summary: 'List venues' })
  @ApiOkResponse({ type: [VenueDto] })
  list(): Promise<VenueDto[]> {
    return this.presets.listVenues() as Promise<VenueDto[]>;
  }

  @Post()
  @ApiOperation({
    summary: 'Add a venue',
    description:
      'The room, and what you learned about it last time you were in it.',
  })
  @ApiCreatedResponse({ type: VenueDto })
  @ApiConflictResponse({
    description: 'A venue with that name already exists.',
  })
  create(@Body() body: CreateVenueDto): Promise<VenueDto> {
    return this.presets.createVenue(body) as Promise<VenueDto>;
  }

  @Get(':id')
  @ApiOkResponse({ type: VenueDto })
  @ApiNotFoundResponse()
  get(@Param('id') id: string): Promise<VenueDto> {
    return this.presets.getVenue(id) as Promise<VenueDto>;
  }

  @Patch(':id')
  @ApiOkResponse({ type: VenueDto })
  update(
    @Param('id') id: string,
    @Body() body: UpdateVenueDto,
  ): Promise<VenueDto> {
    return this.presets.updateVenue(id, body) as Promise<VenueDto>;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse({
    description: 'Presets that referenced it keep their values.',
  })
  async remove(@Param('id') id: string): Promise<void> {
    await this.presets.deleteVenue(id);
  }
}

@ApiTags('bands')
@Controller('bands')
export class BandController {
  constructor(private readonly presets: PresetService) {}

  @Get()
  @ApiOperation({ summary: 'List bands' })
  @ApiOkResponse({ type: [BandDto] })
  list(): Promise<BandDto[]> {
    return this.presets.listBands() as Promise<BandDto[]>;
  }

  @Post()
  @ApiOperation({
    summary: 'Add a band and its input list',
    description:
      'What is plugged into what, what it is called, and where the gain starts.',
  })
  @ApiCreatedResponse({ type: BandDto })
  @ApiConflictResponse({ description: 'A band with that name already exists.' })
  create(@Body() body: CreateBandDto): Promise<BandDto> {
    return this.presets.createBand(body) as Promise<BandDto>;
  }

  @Get(':id')
  @ApiOkResponse({ type: BandDto })
  @ApiNotFoundResponse()
  get(@Param('id') id: string): Promise<BandDto> {
    return this.presets.getBand(id) as Promise<BandDto>;
  }

  @Patch(':id')
  @ApiOkResponse({ type: BandDto })
  update(
    @Param('id') id: string,
    @Body() body: UpdateBandDto,
  ): Promise<BandDto> {
    return this.presets.updateBand(id, body) as Promise<BandDto>;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(@Param('id') id: string): Promise<void> {
    await this.presets.deleteBand(id);
  }

  @Post(':id/apply-input-list')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Write the input list onto a console',
    description:
      'Names, colours, head amp gains and phantom power for every input in the list. This is ' +
      'the fifteen minutes before doors when the desk still says "Ch01".',
  })
  @ApiOkResponse({ type: ApplyReportDto })
  applyInputList(
    @Param('id') id: string,
    @Body() body: ApplyInputListDto,
  ): Promise<ApplyReportDto> {
    return this.presets.applyInputList(body.consoleId, id, {
      rampMs: body.rampMs,
    }) as Promise<ApplyReportDto>;
  }
}

@ApiTags('presets')
@Controller('presets')
export class PresetController {
  constructor(private readonly presets: PresetService) {}

  @Get()
  @ApiOperation({ summary: 'List presets, optionally by venue or band' })
  @ApiQuery({ name: 'venueId', required: false })
  @ApiQuery({ name: 'bandId', required: false })
  @ApiOkResponse({ type: [PresetDto] })
  list(
    @Query('venueId') venueId?: string,
    @Query('bandId') bandId?: string,
  ): Promise<PresetDto[]> {
    return this.presets.listPresets({ venueId, bandId }) as Promise<
      PresetDto[]
    >;
  }

  @Post()
  @ApiOperation({
    summary: 'Save a preset',
    description:
      'Captures the console as it stands (or takes explicit values). Capture can be narrowed ' +
      'to particular strips and sections — a band preset is usually channel names, colours ' +
      'and gains; a venue preset is usually bus EQ and matrix levels.',
  })
  @ApiCreatedResponse({ type: PresetDto })
  @ApiConflictResponse({
    description: 'That name is taken for this venue and band.',
  })
  create(@Body() body: CreatePresetDto): Promise<PresetDto> {
    return this.presets.createPreset(body) as Promise<PresetDto>;
  }

  @Get(':id')
  @ApiOkResponse({ type: PresetDto })
  @ApiNotFoundResponse()
  get(@Param('id') id: string): Promise<PresetDto> {
    return this.presets.getPreset(id) as Promise<PresetDto>;
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiNoContentResponse()
  async remove(@Param('id') id: string): Promise<void> {
    await this.presets.deletePreset(id);
  }

  @Get(':id/versions')
  @ApiOperation({
    summary: 'Version history, newest first',
    description:
      'Versions are never rewritten, so anything that was ever saved can come back.',
  })
  @ApiOkResponse({ type: [PresetVersionDto] })
  versions(@Param('id') id: string): Promise<PresetVersionDto[]> {
    return this.presets.listVersions(id) as Promise<PresetVersionDto[]>;
  }

  @Get(':id/versions/:version')
  @ApiOkResponse({ type: PresetVersionDto })
  @ApiNotFoundResponse()
  version(
    @Param('id') id: string,
    @Param('version') version: string,
  ): Promise<PresetVersionDto> {
    return this.presets.getVersion(
      id,
      Number(version),
    ) as Promise<PresetVersionDto>;
  }

  @Post(':id/versions')
  @ApiOperation({
    summary: 'Save the console as a new version of this preset',
    description: 'The previous version stays exactly where it was.',
  })
  @ApiCreatedResponse({ type: PresetVersionDto })
  capture(
    @Param('id') id: string,
    @Body() body: CaptureVersionDto,
  ): Promise<PresetVersionDto> {
    return this.presets.captureVersion(id, body) as Promise<PresetVersionDto>;
  }

  @Post(':id/rollback')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Make an earlier version current again',
    description: 'Nothing is deleted, so a rollback is itself reversible.',
  })
  @ApiOkResponse({ type: PresetDto })
  rollback(
    @Param('id') id: string,
    @Body() body: RollbackDto,
  ): Promise<PresetDto> {
    return this.presets.rollback(id, body.version) as Promise<PresetDto>;
  }

  @Post(':id/preview')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'What applying this preset would change',
    description:
      'Sends nothing. Safe to call during a show, and the honest way to answer "what is this ' +
      'preset about to do to my mix".',
  })
  @ApiOkResponse({ type: PresetPreviewDto })
  preview(
    @Param('id') id: string,
    @Body() body: ApplyPresetDto,
  ): Promise<PresetPreviewDto> {
    return this.presets.preview(
      id,
      body.consoleId,
      body.version,
    ) as Promise<PresetPreviewDto>;
  }

  @Post(':id/apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Apply the preset to a console',
    description:
      'Only what differs is sent, and levels are ramped rather than jumped so the recall does ' +
      'not click. Applying a preset the console already matches sends nothing at all.',
  })
  @ApiOkResponse({ type: ApplyReportDto })
  apply(
    @Param('id') id: string,
    @Body() body: ApplyPresetDto,
  ): Promise<ApplyReportDto> {
    return this.presets.applyPreset(id, body.consoleId, {
      version: body.version,
      rampMs: body.rampMs,
      immediate: body.immediate,
    }) as Promise<ApplyReportDto>;
  }
}
