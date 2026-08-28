import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/auth.decorators.js';
import {
  AuditEntryDto,
  AuditQueryDto,
  CaptureSafeStateDto,
  PanicDto,
  SafetyStatusDto,
  SetReadOnlyDto,
} from './dto/safety.dto.js';
import { AllowedWhenReadOnly } from './read-only.guard.js';
import { SafetyService } from './safety.service.js';
import type { PanicMode, PanicResult } from './safety.service.js';

@ApiTags('safety')
@ApiBearerAuth()
@Controller('safety')
export class SafetyController {
  constructor(private readonly safety: SafetyService) {}

  @Get()
  @Roles('observer')
  @ApiOperation({
    summary: 'What protections are currently on',
    description:
      'Worth putting somewhere visible in a UI: an operator should be able to see at a ' +
      'glance whether their changes are reaching the console at all.',
  })
  @ApiOkResponse({ type: SafetyStatusDto })
  status(): Promise<SafetyStatusDto> {
    return this.safety.status() as Promise<SafetyStatusDto>;
  }

  @Post('read-only')
  @Roles('admin')
  @AllowedWhenReadOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Turn read-only mode on or off',
    description:
      'While it is on, anything that would change a console is refused with 423 Locked. ' +
      'Reads, logging in and PANIC keep working.',
  })
  @ApiOkResponse({ type: SafetyStatusDto })
  async setReadOnly(@Body() body: SetReadOnlyDto): Promise<SafetyStatusDto> {
    this.safety.setReadOnly(body.enabled, body.reason);
    return (await this.safety.status()) as SafetyStatusDto;
  }

  @Post('safe-state')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Record the console as it stands as the state PANIC returns to',
    description:
      'Saved as an ordinary preset, so it is versioned and can be inspected before anybody ' +
      'has to trust it. Capture it once the room sounds right, before doors.',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: { presetId: { type: 'string' }, version: { type: 'number' } },
    },
  })
  captureSafeState(
    @Body() body: CaptureSafeStateDto,
    @CurrentUser() user?: Principal,
  ): Promise<{ presetId: string; version: number }> {
    return this.safety.captureSafeState(body.consoleId, user?.username);
  }

  @Post('panic')
  @AllowedWhenReadOnly()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Put the console back, now',
    description:
      'No ramp and no confirmation — a ramp is for a musical transition and this is not ' +
      'one. `safe-state` restores what was captured; `mute-all` mutes every strip and needs ' +
      'nothing captured beforehand. Works while read-only is on: read-only prevents ' +
      'accidents, PANIC ends one.',
  })
  @ApiOkResponse({ description: 'What was restored, and what it changed.' })
  @ApiNotFoundResponse({
    description: 'No safe state captured for that console.',
  })
  panic(@Body() body: PanicDto): Promise<PanicResult> {
    return this.safety.panic(
      body.consoleId,
      (body.mode as PanicMode) ?? 'safe-state',
    );
  }

  @Get('audit')
  @Roles('engineer')
  @ApiOperation({
    summary: 'What this API has been asked to do, and by whom',
    description: 'Newest first. Only state-changing requests are recorded.',
  })
  @ApiOkResponse({ type: [AuditEntryDto] })
  audit(@Query() query: AuditQueryDto): Promise<AuditEntryDto[]> {
    return this.safety.listAudit(query) as Promise<AuditEntryDto[]>;
  }
}
