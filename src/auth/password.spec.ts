import { describe, expect, it } from 'vitest';
import { DEFAULT_PARAMS, hashPassword, verifyPassword } from './password.js';

/** Cheap parameters: these tests are about behaviour, not about how slow it is. */
const FAST = { ...DEFAULT_PARAMS, cost: 2 ** 10 };

describe('password hashing', () => {
  it('accepts the right password', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(
      true,
    );
  });

  it('rejects the wrong one', async () => {
    const hash = await hashPassword('correct horse battery staple', FAST);
    expect(await verifyPassword('correct horse battery stapler', hash)).toBe(
      false,
    );
    expect(await verifyPassword('', hash)).toBe(false);
  });

  it('produces a different hash every time, so equal passwords are not visible', async () => {
    const a = await hashPassword('same password', FAST);
    const b = await hashPassword('same password', FAST);
    expect(a).not.toBe(b);
    expect(await verifyPassword('same password', a)).toBe(true);
    expect(await verifyPassword('same password', b)).toBe(true);
  });

  it('carries its parameters, so they can be raised later without invalidating anything', async () => {
    const hash = await hashPassword('x', FAST);
    const [scheme, cost, blockSize, parallelisation] = hash.split('$');

    expect(scheme).toBe('scrypt');
    expect(Number(cost)).toBe(FAST.cost);
    expect(Number(blockSize)).toBe(FAST.blockSize);
    expect(Number(parallelisation)).toBe(FAST.parallelisation);

    // A hash made with stronger parameters still verifies against the same
    // password, because the cost travels with it.
    const stronger = await hashPassword('x', { ...FAST, cost: 2 ** 12 });
    expect(await verifyPassword('x', stronger)).toBe(true);
  });

  it('treats equivalent unicode spellings as the same password', async () => {
    // Composed vs decomposed "é": a password typed on a different keyboard
    // layout must still let its owner in.
    const hash = await hashPassword('café', FAST);
    expect(await verifyPassword('café', hash)).toBe(true);
  });

  it('refuses a hash that is not one, instead of throwing', async () => {
    for (const stored of [
      '',
      'not-a-hash',
      'scrypt$x$8$1$aaaa$bbbb',
      'bcrypt$1$2$3$4$5',
    ]) {
      expect(await verifyPassword('anything', stored)).toBe(false);
    }
  });

  it('rejects a tampered hash', async () => {
    const hash = await hashPassword('password', FAST);
    const parts = hash.split('$');
    // Flip the last character of the digest.
    parts[5] = parts[5].slice(0, -1) + (parts[5].endsWith('A') ? 'B' : 'A');
    expect(await verifyPassword('password', parts.join('$'))).toBe(false);
  });
});
