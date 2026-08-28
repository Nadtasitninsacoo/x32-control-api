import { plainToInstance, Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  Min,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Test = 'test',
  Production = 'production',
}

/** `TRUE`, `1`, `yes` and `on` all mean true; everything else is false. */
const toBoolean = ({ value }: { value: unknown }): boolean => {
  if (typeof value === 'boolean') return value;
  if (value === undefined || value === null || value === '') return false;
  return ['1', 'true', 'yes', 'on'].includes(
    String(value).trim().toLowerCase(),
  );
};

const toInt = ({ value }: { value: unknown }): unknown =>
  value === undefined || value === null || value === ''
    ? undefined
    : Number(value);

export class EnvVars {
  @IsEnum(NodeEnv)
  NODE_ENV: NodeEnv = NodeEnv.Development;

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  PORT = 3000;

  /* --- OSC / console link --- */

  /** Default console address; may be left empty and discovered instead. */
  @IsString()
  X32_HOST = '';

  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(65535)
  X32_PORT = 10023;

  /** Local UDP port to bind. 0 lets the OS choose (recommended). */
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(65535)
  OSC_LOCAL_PORT = 0;

  /** Broadcast address used by console discovery. */
  @IsString()
  @IsNotEmpty()
  OSC_BROADCAST_ADDRESS = '255.255.255.255';

  /** Sustained send ceiling. The console drops packets well above ~50/s. */
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(200)
  OSC_MAX_MSG_PER_SEC = 50;

  /** Hard floor on the gap between two datagrams, in milliseconds. */
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(1000)
  OSC_MIN_GAP_MS = 2;

  /** Depth at which the send queue starts rejecting work. 0 = unbounded. */
  @Transform(toInt)
  @IsInt()
  @Min(0)
  OSC_MAX_QUEUE_LENGTH = 5000;

  /** How long to wait for a reply before giving up on a query. */
  @Transform(toInt)
  @IsInt()
  @Min(50)
  @Max(30000)
  OSC_REQUEST_TIMEOUT_MS = 1000;

  /** /xremote renewal period. The console forgets subscribers after 10s. */
  @Transform(toInt)
  @IsInt()
  @Min(1000)
  @Max(9500)
  XREMOTE_INTERVAL_MS = 8000;

  /* --- Safety --- */

  /** Log state-changing OSC instead of sending it. */
  @Transform(toBoolean)
  @IsBoolean()
  DRY_RUN = false;
}

export function validateEnv(raw: Record<string, unknown>): EnvVars {
  const config = plainToInstance(EnvVars, raw, {
    enableImplicitConversion: false,
    exposeDefaultValues: true,
  });

  const errors = validateSync(config, {
    skipMissingProperties: false,
    whitelist: false,
  });
  if (errors.length > 0) {
    const detail = errors
      .map(
        (e) =>
          `  ${e.property}: ${Object.values(e.constraints ?? {}).join(', ')}`,
      )
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${detail}`);
  }
  return config;
}
