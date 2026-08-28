import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ImportReportDto,
  ImportScnDto,
  RecallSlotDto,
  SaveSceneDto,
  ShowSlotDto,
} from './dto/scene.dto.js';
import { SceneService } from './scene.service.js';
import type { ShowSlotKind } from './scene.service.js';

@ApiTags('scenes')
@Controller('consoles/:consoleId/show')
export class SceneController {
  constructor(private readonly scenes: SceneService) {}

  // Declared before the ':kind' routes: a wildcard segment would
  // otherwise swallow "current-cue" and "export.scn".
  @Get('current-cue')
  @ApiOperation({ summary: 'Which cue the console is sitting on' })
  @ApiOkResponse({
    schema: { type: 'object', properties: { index: { type: 'number' } } },
  })
  async currentCue(
    @Param('consoleId') consoleId: string,
  ): Promise<{ index: number | undefined }> {
    return { index: await this.scenes.currentCue(consoleId) };
  }

  @Get('export.scn')
  @ApiOperation({
    summary: 'Export the current mixing state as a .scn file',
    description:
      'A scene file in the console text format. It carries the mixing surface this project ' +
      'models — strips, sends, processing — and not routing, effects or the recorder, so it ' +
      'is a mixing snapshot rather than a full show backup.',
  })
  @ApiQuery({ name: 'name', required: false, example: 'Rock Night' })
  @ApiQuery({ name: 'note', required: false })
  @ApiProduces('text/plain')
  @Header('content-type', 'text/plain; charset=utf-8')
  @Header('content-disposition', 'attachment; filename="scene.scn"')
  export(
    @Param('consoleId') consoleId: string,
    @Query('name') name?: string,
    @Query('note') note?: string,
  ): string {
    return this.scenes.exportScn(consoleId, name ?? 'Export', note ?? '');
  }

  @Get(':kind')
  @ApiOperation({
    summary: 'List the occupied scene, cue or snippet slots on the console',
    description: 'Reads the console show file. Empty slots are omitted.',
  })
  @ApiParam({ name: 'kind', enum: ['scene', 'cue', 'snippet'] })
  @ApiOkResponse({ type: [ShowSlotDto] })
  list(
    @Param('consoleId') consoleId: string,
    @Param('kind') kind: ShowSlotKind,
  ): Promise<ShowSlotDto[]> {
    return this.scenes.list(consoleId, kind);
  }

  @Post(':kind/recall')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Recall a scene, cue or snippet',
    description:
      'The console does the recall itself, so it is instant and complete — including the ' +
      'parts this API does not model. The state mirror is re-read afterwards.',
  })
  @ApiParam({ name: 'kind', enum: ['scene', 'cue', 'snippet'] })
  async recall(
    @Param('consoleId') consoleId: string,
    @Param('kind') kind: ShowSlotKind,
    @Body() body: RecallSlotDto,
  ): Promise<void> {
    await this.scenes.recall(consoleId, kind, body.index);
  }

  @Post('scene/save')
  @ApiOperation({
    summary: 'Write the current state into a console scene slot',
    description:
      'Overwrites whatever is in that slot on the console, so it needs confirm="OVERWRITE". ' +
      'The exact save command is not verified against hardware — prefer a venue preset, ' +
      'which lives in this API and can be rolled back.',
  })
  @ApiForbiddenResponse({ description: 'Missing or wrong confirmation token.' })
  save(
    @Param('consoleId') consoleId: string,
    @Body() body: SaveSceneDto,
  ): Promise<{ index: number; name: string; verified: false }> {
    return this.scenes.saveScene(
      consoleId,
      body.index,
      body.name,
      body.note ?? '',
      body.confirm,
    );
  }

  @Post('import')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Read a .scn file, and optionally load it',
    description:
      'Without `apply` this only reports what the file contains and what could not be ' +
      'decoded — safe to run during a show. With `apply` and confirm="OVERWRITE" the values ' +
      'are sent to the console, levels ramped so nothing clicks.',
  })
  @ApiOkResponse({ type: ImportReportDto })
  @ApiForbiddenResponse({
    description: 'apply was requested without the confirmation token.',
  })
  import(
    @Param('consoleId') consoleId: string,
    @Body() body: ImportScnDto,
  ): Promise<ImportReportDto> {
    return this.scenes.importScn(consoleId, body.content, {
      apply: body.apply,
      rampMs: body.rampMs,
      confirm: body.confirm,
    }) as Promise<ImportReportDto>;
  }
}
