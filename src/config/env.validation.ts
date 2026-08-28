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

export enum SyncDepth {
  Surface = 'surface',
  Sends = 'sends',
  Full = 'full',
}

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

  /* --- Console link supervision --- */

  /** Connect to X32_HOST at boot, when one is configured. */
  @Transform(toBoolean)
  @IsBoolean()
  CONSOLE_AUTO_CONNECT = true;

  /** How often to check the console is still answering. */
  @Transform(toInt)
  @IsInt()
  @Min(250)
  @Max(60000)
  CONSOLE_PROBE_INTERVAL_MS = 2000;

  @Transform(toInt)
  @IsInt()
  @Min(50)
  @Max(10000)
  CONSOLE_PROBE_TIMEOUT_MS = 1000;

  /** Consecutive unanswered probes before the link counts as lost. */
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(10)
  CONSOLE_MAX_MISSED_PROBES = 2;

  @Transform(toInt)
  @IsInt()
  @Min(100)
  @Max(60000)
  CONSOLE_RECONNECT_MIN_MS = 500;

  /**
   * Reconnect backoff ceiling. Kept low on purpose: a console that comes back
   * must be picked up within seconds, not minutes.
   */
  @Transform(toInt)
  @IsInt()
  @Min(500)
  @Max(60000)
  CONSOLE_RECONNECT_MAX_MS = 5000;

  /** How much of the console to mirror: surface | sends | full. */
  @IsEnum(SyncDepth)
  CONSOLE_SYNC_DEPTH: SyncDepth = SyncDepth.Full;

  /** How long a discovery sweep listens for answers. */
  @Transform(toInt)
  @IsInt()
  @Min(100)
  @Max(30000)
  DISCOVERY_TIMEOUT_MS = 1500;

  /* --- Metering --- */

  /**
   * Frames per second pushed to WebSocket clients. The console can send meters
   * faster than this; frames are coalesced rather than queued, so a client sees
   * current meters instead of a backlog.
   */
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(60)
  METER_FPS = 20;

  /** Meter subscription renewal period. The console forgets it after 10s. */
  @Transform(toInt)
  @IsInt()
  @Min(500)
  @Max(9500)
  METER_RENEW_MS = 5000;

  /** Console-side meter rate divider; 1 is roughly 50ms per update. */
  @Transform(toInt)
  @IsInt()
  @Min(1)
  @Max(99)
  METER_TIME_FACTOR = 1;

  /* --- Authentication --- */

  /**
   * When false, every request runs as an administrator. That is a reasonable
   * default on a closed show network and a bad one on a shared one; the API
   * says which it is doing at boot.
   */
  @Transform(toBoolean)
  @IsBoolean()
  AUTH_ENABLED = false;

  /** Signing key for access tokens. Required once AUTH_ENABLED is true. */
  @IsString()
  JWT_SECRET = '';

  @Transform(toInt)
  @IsInt()
  @Min(60)
  @Max(2_592_000)
  JWT_EXPIRES_IN_SECONDS = 43_200;

  /** Creates the first administrator when authentication is on and none exist. */
  @IsString()
  AUTH_BOOTSTRAP_USERNAME = '';

  @IsString()
  AUTH_BOOTSTRAP_PASSWORD = '';

  /* --- Storage --- */

  /**
   * PostgreSQL connection string for venue presets. Leave it empty and the
   * presets live in memory instead: everything works, nothing survives a
   * restart, and the log says so at boot.
   */
  @IsString()
  DATABASE_URL = '';

  /* --- Applying presets and scenes --- */

  /**
   * Default ramp time for level changes. A fader that jumps clicks; the
   * 300-800ms window is where a move sounds deliberate rather than either
   * abrupt or sluggish.
   */
  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(5000)
  RAMP_DEFAULT_MS = 400;

  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(5000)
  RAMP_MIN_MS = 300;

  @Transform(toInt)
  @IsInt()
  @Min(0)
  @Max(10000)
  RAMP_MAX_MS = 800;

  /* --- Safety --- */

  /** Log state-changing OSC instead of sending it. */
  @Transform(toBoolean)
  @IsBoolean()
  DRY_RUN = false;

  /**
   * Start in read-only mode: reads work, anything that would change the console
   * is refused with 423 Locked. Can be flipped at runtime without a restart.
   */
  @Transform(toBoolean)
  @IsBoolean()
  READ_ONLY = false;
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
