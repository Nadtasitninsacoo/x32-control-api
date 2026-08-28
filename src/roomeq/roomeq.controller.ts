import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Roles } from '../auth/auth.decorators.js';
import { AllowedWhenReadOnly } from '../safety/read-only.guard.js';
import { ApplyReportDto } from '../scene/dto/scene.dto.js';
import {
  AnalyzeRoomEqDto,
  ApplyRoomEqDto,
  PeqBandDto,
  RoomEqAnalysisDto,
} from './dto/roomeq.dto.js';
import { RoomEqAnalysis, RoomEqService } from './roomeq.service.js';

function toAnalysisDto(analysis: RoomEqAnalysis): RoomEqAnalysisDto {
  return {
    bands: analysis.bands as PeqBandDto[],
    curves: {
      frequencies: [...analysis.frequencies],
      before: [...analysis.before],
      after: [...analysis.after],
      target: [...analysis.target],
    },
    deviationBeforeDb: analysis.deviationBeforeDb,
    deviationAfterDb: analysis.deviationAfterDb,
    measurementPoints: analysis.measurementPoints,
    measurementMinHz: analysis.measurementMinHz,
    measurementMaxHz: analysis.measurementMaxHz,
    notes: [...analysis.notes],
    warnings: [...analysis.warnings],
  };
}

@ApiTags('room eq')
@Controller()
export class RoomEqController {
  constructor(private readonly roomEq: RoomEqService) {}

  @Post('roomeq/analyze')
  @Roles('observer')
  @AllowedWhenReadOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Fit a correction to a room measurement',
    description:
      'Reads a REW text export or a CSV, smooths it, and fits PEQ bands: cuts freely, ' +
      'boosts only up to a ceiling, and only inside the range EQ can actually fix. Touches ' +
      'no console — the response carries before/after/target curves for plotting, the bands ' +
      'themselves, and warnings worth reading before applying anything.',
  })
  @ApiOkResponse({ type: RoomEqAnalysisDto })
  @ApiBadRequestResponse({ description: 'The measurement could not be read.' })
  analyze(@Body() body: AnalyzeRoomEqDto): RoomEqAnalysisDto {
    const { measurement, ...fit } = body;
    return toAnalysisDto(
      this.roomEq.analyze(measurement, { ...fit, bands: fit.bands ?? 6 }),
    );
  }

  @Post('consoles/:consoleId/roomeq/apply')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Write a correction to a strip',
    description:
      'Fits a measurement (or takes bands an operator has already edited) and writes it to ' +
      "the strip's parametric EQ. Bands the correction does not use are flattened, so an " +
      'older correction cannot stay half-applied underneath the new one.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        strip: { type: 'string', example: 'bus/01' },
        bands: {
          type: 'array',
          items: { $ref: '#/components/schemas/PeqBandDto' },
        },
        analysis: { $ref: '#/components/schemas/RoomEqAnalysisDto' },
        apply: { $ref: '#/components/schemas/ApplyReportDto' },
      },
    },
  })
  @ApiBadRequestResponse({
    description: 'No measurement or bands given, or the strip has no EQ.',
  })
  async apply(
    @Param('consoleId') consoleId: string,
    @Body() body: ApplyRoomEqDto,
  ): Promise<{
    strip: string;
    bands: PeqBandDto[];
    analysis?: RoomEqAnalysisDto;
    apply: ApplyReportDto;
  }> {
    const {
      strip,
      measurement,
      bandValues,
      flattenUnusedBands,
      enableEq,
      ...fit
    } = body;
    const result = await this.roomEq.applyToStrip(consoleId, strip, {
      measurement,
      bands: bandValues,
      fit,
      flattenUnusedBands,
      enableEq,
    });

    return {
      strip: result.strip,
      bands: result.bands as PeqBandDto[],
      analysis: result.analysis ? toAnalysisDto(result.analysis) : undefined,
      apply: result.apply as unknown as ApplyReportDto,
    };
  }
}
