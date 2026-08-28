import {
  BadRequestException,
  Controller,
  Get,
  Param,
  Query,
} from '@nestjs/common';
import {
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { SUBSCRIBED_BANKS } from './meter-banks.js';
import { MeterFrameDto, RawMeterBankDto } from './dto/meters.dto.js';
import { MeteringService } from './metering.service.js';

@ApiTags('metering')
@Controller('consoles/:consoleId/meters')
export class MeteringController {
  constructor(private readonly meters: MeteringService) {}

  @Get()
  @ApiOperation({
    summary: 'Most recent meter frame',
    description:
      'A snapshot, for a page that only needs an occasional reading. Anything that draws ' +
      'moving meters should use the WebSocket stream instead — this endpoint returns ' +
      'whatever the stream last produced, and silence if nobody is streaming.',
  })
  @ApiOkResponse({ type: MeterFrameDto })
  @ApiNotFoundResponse({ description: 'No console with this id.' })
  latest(@Param('consoleId') consoleId: string): MeterFrameDto {
    const frame = this.meters.latest(consoleId);
    if (frame) return frame;
    return {
      consoleId,
      at: Date.now(),
      channels: [],
      mains: { left: -90, right: -90, mono: -90 },
    };
  }

  @Get('raw')
  @ApiOperation({
    summary: 'One meter bank, unmapped',
    description:
      'Every slot of a bank in dBFS. This is the calibration tool for the parts of a bank ' +
      'this project does not map yet: send signal into one input on a real console and see ' +
      'which index moves.',
  })
  @ApiQuery({
    name: 'bank',
    required: false,
    enum: SUBSCRIBED_BANKS.map((bank) => bank.address),
  })
  @ApiOkResponse({ type: RawMeterBankDto })
  async raw(
    @Param('consoleId') consoleId: string,
    @Query('bank') bank?: string,
  ): Promise<RawMeterBankDto> {
    const address = bank ?? SUBSCRIBED_BANKS[0].address;
    if (!/^\/meters\/\d{1,2}$/.test(address)) {
      throw new BadRequestException(`"${address}" is not a meter bank address`);
    }
    const values = await this.meters.readRawBank(consoleId, address);
    return { bank: address, count: values.length, values };
  }
}
