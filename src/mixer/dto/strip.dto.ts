import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CHANNEL_COLORS,
  COMP_RATIOS,
  MAX_FADER_DB,
  MIN_FADER_DB,
} from '../../osc/units/x32-units.js';
import {
  DYN_DETECTORS,
  DYN_ENVELOPES,
  DYN_MODES,
  DYN_POSITIONS,
  EQ_TYPES,
  GATE_MODES,
} from '../../osc/schema/x32-schema.js';

/**
 * What the API returns for a strip.
 *
 * Every value is in engineering units — dB, Hz, ms, percent, ON/OFF — and
 * every field name carries its unit. Nothing here exposes a console float.
 */

export class StripConfigDto {
  @ApiProperty({ example: 'Kick In', description: 'Scribble strip name.' })
  name!: string;

  @ApiProperty({ example: 1, description: 'Console icon index.' })
  icon!: number;

  @ApiProperty({ enum: CHANNEL_COLORS, example: 'GN' })
  color!: string;

  @ApiPropertyOptional({
    example: 1,
    description: 'Input source index. Channels and aux inputs only.',
  })
  source?: number;
}

export class StripMixDto {
  @ApiProperty({
    example: false,
    description:
      'True when the strip is muted. The console stores the inverse.',
  })
  muted!: boolean;

  @ApiProperty({
    example: -6,
    minimum: MIN_FADER_DB,
    maximum: MAX_FADER_DB,
    description: `Fader position in dB. ${MIN_FADER_DB} is -∞.`,
  })
  faderDb!: number;

  @ApiProperty({
    example: 0,
    minimum: -100,
    maximum: 100,
    description: 'Pan, L-100 … R+100.',
  })
  pan!: number;

  @ApiPropertyOptional({
    example: true,
    description: 'Assigned to the stereo main.',
  })
  stereo?: boolean;

  @ApiPropertyOptional({
    example: false,
    description: 'Assigned to the mono main.',
  })
  mono?: boolean;

  @ApiPropertyOptional({
    example: -90,
    description: 'Send level to the mono main, in dB.',
  })
  monoLevelDb?: number;
}

export class SendDto {
  @ApiProperty({
    example: 3,
    description: 'Destination bus (or matrix) number.',
  })
  to!: number;

  @ApiProperty({ example: true })
  on!: boolean;

  @ApiProperty({ example: -12, description: 'Send level in dB.' })
  levelDb!: number;

  @ApiPropertyOptional({
    example: 0,
    description: 'Send pan, where the destination is stereo.',
  })
  pan?: number;
}

export class PreampDto {
  @ApiProperty({
    example: 0,
    minimum: -18,
    maximum: 18,
    description: 'Digital trim in dB.',
  })
  trimDb!: number;

  @ApiProperty({ example: false, description: 'Polarity invert.' })
  invert!: boolean;

  @ApiProperty({ example: true, description: 'Low-cut filter engaged.' })
  lowCutOn!: boolean;

  @ApiProperty({
    example: 80,
    minimum: 20,
    maximum: 400,
    description: 'Low-cut corner in Hz.',
  })
  lowCutHz!: number;

  @ApiPropertyOptional({
    example: 24,
    minimum: -12,
    maximum: 60,
    description: 'Head amp gain in dB. Channels fed by a local XLR input only.',
  })
  gainDb?: number;

  @ApiPropertyOptional({ example: false, description: '+48V phantom power.' })
  phantom?: boolean;
}

export class GateDto {
  @ApiProperty({ example: false })
  on!: boolean;

  @ApiProperty({ enum: GATE_MODES, example: 'GATE' })
  mode!: string;

  @ApiProperty({
    example: -40,
    minimum: -80,
    maximum: 0,
    description: 'Threshold in dB.',
  })
  thresholdDb!: number;

  @ApiProperty({
    example: 24,
    minimum: 3,
    maximum: 60,
    description: 'Attenuation depth in dB.',
  })
  rangeDb!: number;

  @ApiProperty({ example: 10, minimum: 0, maximum: 120 })
  attackMs!: number;

  @ApiProperty({ example: 50, minimum: 0.02, maximum: 2000 })
  holdMs!: number;

  @ApiProperty({ example: 250, minimum: 5, maximum: 4000 })
  releaseMs!: number;
}

export class DynamicsDto {
  @ApiProperty({ example: true })
  on!: boolean;

  @ApiProperty({ enum: DYN_MODES, example: 'COMP' })
  mode!: string;

  @ApiProperty({ enum: DYN_DETECTORS, example: 'RMS' })
  detection!: string;

  @ApiProperty({ enum: DYN_ENVELOPES, example: 'LOG' })
  envelope!: string;

  @ApiProperty({
    example: -18,
    minimum: -60,
    maximum: 0,
    description: 'Threshold in dB.',
  })
  thresholdDb!: number;

  @ApiProperty({
    enum: COMP_RATIOS,
    example: 4,
    description:
      'Ratio. Values off this list snap to the nearest the console offers.',
  })
  ratio!: number;

  @ApiProperty({ example: 2.5, minimum: 0, maximum: 5 })
  knee!: number;

  @ApiProperty({
    example: 3,
    minimum: 0,
    maximum: 24,
    description: 'Make-up gain in dB.',
  })
  makeupGainDb!: number;

  @ApiProperty({ example: 10, minimum: 0, maximum: 120 })
  attackMs!: number;

  @ApiProperty({ example: 50, minimum: 0.02, maximum: 2000 })
  holdMs!: number;

  @ApiProperty({ example: 150, minimum: 5, maximum: 4000 })
  releaseMs!: number;

  @ApiProperty({ enum: DYN_POSITIONS, example: 'POST' })
  position!: string;

  @ApiProperty({
    example: 100,
    minimum: 0,
    maximum: 100,
    description: 'Wet/dry mix in percent.',
  })
  mixPercent!: number;
}

export class EqBandDto {
  @ApiProperty({ example: 2, description: 'Band number, 1-based.' })
  band!: number;

  @ApiProperty({ enum: EQ_TYPES, example: 'PEQ' })
  type!: string;

  @ApiProperty({ example: 1000, minimum: 20, maximum: 20000 })
  frequencyHz!: number;

  @ApiProperty({ example: -4.5, minimum: -15, maximum: 15 })
  gainDb!: number;

  @ApiProperty({
    example: 2,
    minimum: 0.3,
    maximum: 10,
    description: 'Bandwidth. Higher is narrower.',
  })
  q!: number;
}

export class EqDto {
  @ApiProperty({ example: true })
  on!: boolean;

  @ApiProperty({ type: [EqBandDto] })
  bands!: EqBandDto[];
}

export class StripDto {
  @ApiProperty({ example: 'ch/01', description: 'Strip id, as used in URLs.' })
  id!: string;

  @ApiProperty({
    example: 'ch',
    enum: ['ch', 'auxin', 'fxrtn', 'bus', 'mtx', 'main', 'dca'],
  })
  kind!: string;

  @ApiProperty({ example: '01' })
  index!: string;

  @ApiProperty({
    example: '/ch/01',
    description: 'OSC root, for troubleshooting.',
  })
  oscRoot!: string;

  @ApiProperty({ type: StripConfigDto })
  config!: StripConfigDto;

  @ApiProperty({ type: StripMixDto })
  mix!: StripMixDto;

  @ApiPropertyOptional({
    type: [SendDto],
    description: 'Bus sends, or matrix sends on a bus.',
  })
  sends?: SendDto[];

  @ApiPropertyOptional({ type: PreampDto })
  preamp?: PreampDto;

  @ApiPropertyOptional({ type: GateDto })
  gate?: GateDto;

  @ApiPropertyOptional({ type: DynamicsDto })
  dynamics?: DynamicsDto;

  @ApiPropertyOptional({ type: EqDto })
  eq?: EqDto;
}

export class StripSummaryDto {
  @ApiProperty({ example: 'ch/01' })
  id!: string;

  @ApiProperty({ example: 'ch' })
  kind!: string;

  @ApiProperty({ example: '01' })
  index!: string;

  @ApiProperty({ example: 'Kick In' })
  name!: string;

  @ApiProperty({ example: 'GN' })
  color!: string;

  @ApiProperty({ example: -6 })
  faderDb!: number;

  @ApiProperty({ example: false })
  muted!: boolean;
}
