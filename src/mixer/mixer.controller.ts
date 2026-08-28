import { Body, Controller, Get, Param, Patch } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { StripDto, StripSummaryDto } from './dto/strip.dto.js';
import { UpdateStripDto } from './dto/update-strip.dto.js';
import { MixerService } from './mixer.service.js';

@ApiTags('mixer')
@Controller('consoles/:consoleId/strips')
export class MixerController {
  constructor(private readonly mixer: MixerService) {}

  @Get()
  @ApiOperation({
    summary: 'List every strip',
    description:
      'Name, colour, fader and mute for all 32 channels, 8 aux inputs, 8 FX returns, ' +
      '16 buses, 6 matrices, both mains and 8 DCAs — enough to draw a surface.',
  })
  @ApiOkResponse({ type: [StripSummaryDto] })
  @ApiNotFoundResponse({ description: 'No console with this id.' })
  @ApiServiceUnavailableResponse({
    description: 'The console is not connected.',
  })
  list(@Param('consoleId') consoleId: string): Promise<StripSummaryDto[]> {
    return this.mixer.listStrips(consoleId);
  }

  @Get(':kind/:index')
  @ApiOperation({
    summary: 'Read one strip in full',
    description:
      'Everything the strip has: config, mix, sends, preamp, gate, dynamics and EQ — ' +
      'in dB, Hz, ms and percent. Sections the strip does not have are omitted.',
  })
  @ApiParam({
    name: 'kind',
    enum: ['ch', 'auxin', 'fxrtn', 'bus', 'mtx', 'main', 'dca'],
    example: 'ch',
  })
  @ApiParam({
    name: 'index',
    example: '1',
    description: 'Strip number (`1` or `01`), or `st`/`lr`/`m` for the mains.',
  })
  @ApiOkResponse({ type: StripDto })
  @ApiBadRequestResponse({ description: 'No such strip on this console.' })
  get(
    @Param('consoleId') consoleId: string,
    @Param('kind') kind: string,
    @Param('index') index: string,
  ): Promise<StripDto> {
    return this.mixer.getStrip(consoleId, kind, index);
  }

  @Patch(':kind/:index')
  @ApiOperation({
    summary: 'Change part of a strip',
    description:
      'Only the fields present are written; everything else is left alone. Values are ' +
      'rejected if they fall outside what the console can actually do, rather than being ' +
      'clamped silently. A fader move here is immediate — use a venue preset when a ramp ' +
      'is wanted instead of a jump.',
  })
  @ApiOkResponse({ type: StripDto, description: 'The strip after the change.' })
  @ApiBadRequestResponse({
    description: 'A value is out of range, or the strip lacks that section.',
  })
  @ApiServiceUnavailableResponse({
    description: 'The console is not connected.',
  })
  update(
    @Param('consoleId') consoleId: string,
    @Param('kind') kind: string,
    @Param('index') index: string,
    @Body() update: UpdateStripDto,
  ): Promise<StripDto> {
    return this.mixer.updateStrip(consoleId, kind, index, update);
  }
}
