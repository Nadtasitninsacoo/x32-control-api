import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiProperty } from '@nestjs/swagger';
import { ConsoleManagerService } from '../console/console-manager.service.js';

export class HealthDto {
  @ApiProperty({ example: 'ok' })
  status!: string;

  @ApiProperty({ example: 42.5, description: 'Process uptime in seconds.' })
  uptimeSeconds!: number;

  @ApiProperty({ example: 1, description: 'Consoles currently managed.' })
  consoles!: number;

  @ApiProperty({
    example: 1,
    description: 'Of those, how many are usable right now.',
  })
  connected!: number;

  @ApiProperty({
    example: false,
    description: 'DRY_RUN is on: no state-changing OSC is sent.',
  })
  dryRun!: boolean;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly consoles: ConsoleManagerService) {}

  @Get()
  @ApiOperation({
    summary: 'Liveness and console link summary',
    description:
      'Cheap enough for a load balancer; useful enough for a wall display.',
  })
  @ApiOkResponse({ type: HealthDto })
  health(): HealthDto {
    const statuses = this.consoles.list();
    return {
      status: 'ok',
      uptimeSeconds: Math.round(process.uptime() * 10) / 10,
      consoles: statuses.length,
      connected: statuses.filter((s) => s.state === 'connected').length,
      dryRun: statuses.some((s) => s.dryRun),
    };
  }
}
