import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from 'node:crypto';
import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from './password-policy';

const KEY_LENGTH = 64;
const SALT_LENGTH = 16;
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELIZATION = 1;
const MAX_MEMORY = 32 * 1024 * 1024;

export { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH };

/** Create a self-contained scrypt hash: scrypt$N$r$p$salt$derived-key. */
export async function hashPassword(password: string): Promise<string> {
  assertPasswordLength(password);
  const salt = randomBytes(SALT_LENGTH);
  const derivedKey = await deriveKey(password, salt, COST, BLOCK_SIZE, PARALLELIZATION);
  return [
    'scrypt',
    COST,
    BLOCK_SIZE,
    PARALLELIZATION,
    salt.toString('base64url'),
    derivedKey.toString('base64url'),
  ].join('$');
}

/** Verify a stored scrypt hash without revealing whether the email exists. */
export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (
    !encoded ||
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    return false;
  }

  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const cost = Number(parts[1]);
  const blockSize = Number(parts[2]);
  const parallelization = Number(parts[3]);
  if (
    !Number.isInteger(cost) ||
    !Number.isInteger(blockSize) ||
    !Number.isInteger(parallelization) ||
    cost < 16_384 ||
    cost > 32_768 ||
    blockSize < 1 ||
    blockSize > 16 ||
    parallelization < 1 ||
    parallelization > 2
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(parts[4]!, 'base64url');
    const expected = Buffer.from(parts[5]!, 'base64url');
    if (salt.length < 8 || salt.length > 64 || expected.length !== KEY_LENGTH) return false;

    const actual = await deriveKey(password, salt, cost, blockSize, parallelization);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

function assertPasswordLength(password: string): void {
  if (
    typeof password !== 'string' ||
    password.length < PASSWORD_MIN_LENGTH ||
    password.length > PASSWORD_MAX_LENGTH
  ) {
    throw new Error(
      `Password must be between ${PASSWORD_MIN_LENGTH} and ${PASSWORD_MAX_LENGTH} characters`,
    );
  }
}

async function deriveKey(
  password: string,
  salt: Buffer,
  cost: number,
  blockSize: number,
  parallelization: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(
      password,
      salt,
      KEY_LENGTH,
      {
        N: cost,
        r: blockSize,
        p: parallelization,
        maxmem: MAX_MEMORY,
      },
      (error, derivedKey) => {
        if (error) {
          reject(error);
        } else {
          resolve(derivedKey);
        }
      },
    );
  });
}
