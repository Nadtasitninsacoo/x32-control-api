import {
  ScryptOptions,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from 'node:crypto';

/**
 * Password hashing with scrypt.
 *
 * scrypt is in Node's standard library and is a memory-hard KDF, which is the
 * property that matters: it makes a stolen hash expensive to attack even with
 * a GPU. Using it avoids adding a native dependency that has to compile on
 * whatever machine ends up running this at the back of a venue.
 *
 * Format: `scrypt$N$r$p$salt$hash`, all base64url. The parameters travel with
 * the hash, so raising them later does not invalidate existing passwords.
 */

/** promisify() drops the options overload, and the options are the point here. */
function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, derived) => {
      if (error) reject(error);
      else resolve(derived);
    });
  });
}

export interface ScryptParams {
  readonly cost: number;
  readonly blockSize: number;
  readonly parallelisation: number;
  readonly keyLength: number;
}

/** Roughly 100 ms on a modern laptop — slow for an attacker, invisible at login. */
export const DEFAULT_PARAMS: ScryptParams = {
  cost: 2 ** 15,
  blockSize: 8,
  parallelisation: 1,
  keyLength: 32,
};

export async function hashPassword(
  password: string,
  params: ScryptParams = DEFAULT_PARAMS,
): Promise<string> {
  const salt = randomBytes(16);
  const derived = await scryptAsync(
    password.normalize('NFKC'),
    salt,
    params.keyLength,
    {
      N: params.cost,
      r: params.blockSize,
      p: params.parallelisation,
      // Node's default limit is smaller than what N=32768 needs.
      maxmem: 256 * params.cost * params.blockSize,
    },
  );

  return [
    'scrypt',
    params.cost,
    params.blockSize,
    params.parallelisation,
    salt.toString('base64url'),
    derived.toString('base64url'),
  ].join('$');
}

export async function verifyPassword(
  password: string,
  stored: string,
): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelisation = Number(parts[3]);
  if (
    !Number.isInteger(cost) ||
    !Number.isInteger(blockSize) ||
    !Number.isInteger(parallelisation)
  ) {
    return false;
  }

  const salt = Buffer.from(parts[4], 'base64url');
  const expected = Buffer.from(parts[5], 'base64url');

  const derived = await scryptAsync(
    password.normalize('NFKC'),
    salt,
    expected.length,
    {
      N: cost,
      r: blockSize,
      p: parallelisation,
      maxmem: 256 * cost * blockSize,
    },
  );

  // Constant-time: a comparison that returns early leaks the hash one byte at
  // a time to anyone who can measure it.
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}
