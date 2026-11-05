import crypto from 'node:crypto';
const KEY_LENGTH = 64;
const N = 16384;
const R = 8;
const P = 1;

function scryptAsync(password: string, salt: Buffer, keyLength: number, options: crypto.ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => crypto.scrypt(password, salt, keyLength, options, (error, derived) => error ? reject(error) : resolve(derived as Buffer)));
}

export function validatePasswordInput(password: unknown): string {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) {
    // Carries status/code so the shared error handler reports 400 (client input error)
    // rather than falling through to the generic 500 branch.
    const error = new Error('Password must be between 12 and 256 characters.') as Error & { status?: number; code?: string };
    error.status = 400;
    error.code = 'VALIDATION_FAILED';
    throw error;
  }
  return password;
}

export async function hashPassword(password: string): Promise<string> {
  const value = validatePasswordInput(password);
  const salt = crypto.randomBytes(16);
  const derived = await scryptAsync(value, salt, KEY_LENGTH, { N, r: R, p: P });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export async function verifyPassword(password: string, encoded: string | null | undefined): Promise<boolean> {
  if (!encoded) return false;
  const [algorithm, n, r, p, salt64, hash64] = encoded.split('$');
  if (algorithm !== 'scrypt' || !salt64 || !hash64) return false;
  try {
    const derived = await scryptAsync(password, Buffer.from(salt64, 'base64'), Buffer.from(hash64, 'base64').length, { N: Number(n), r: Number(r), p: Number(p) });
    const expected = Buffer.from(hash64, 'base64');
    return expected.length === derived.length && crypto.timingSafeEqual(expected, derived);
  } catch { return false; }
}
