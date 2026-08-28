import { ApiProperty } from '@nestjs/swagger';

export class MainMetersDto {
  @ApiProperty({ example: -12.4, description: 'Main left, dBFS.' })
  left!: number;

  @ApiProperty({ example: -12.1, description: 'Main right, dBFS.' })
  right!: number;

  @ApiProperty({ example: -90, description: 'Main mono, dBFS.' })
  mono!: number;
}

export class MeterFrameDto {
  @ApiProperty({ example: 'default' })
  consoleId!: string;

  @ApiProperty({
    example: 1738000000000,
    description: 'Epoch ms this frame was assembled.',
  })
  at!: number;

  @ApiProperty({
    type: [Number],
    example: [-18.2, -24.6],
    description: 'dBFS for input channels 1-32, in order.',
  })
  channels!: number[];

  @ApiProperty({ type: MainMetersDto })
  mains!: MainMetersDto;
}

export class RawMeterBankDto {
  @ApiProperty({ example: '/meters/1' })
  bank!: string;

  @ApiProperty({ example: 96 })
  count!: number;

  @ApiProperty({
    type: [Number],
    description:
      'Every slot in the bank, in dBFS. Use this to identify slots the mapping does not ' +
      'cover yet: feed one input and watch which index moves.',
  })
  values!: number[];
}
