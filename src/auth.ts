import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const options = { N: 65536, r: 8, p: 1, maxmem: 128 * 1024 * 1024 };
export function isPasswordHash(value: string): boolean { return /^scrypt\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(value); }
function derive(password: string, salt: string): Promise<Buffer> {
  return new Promise((resolve, reject) => scrypt(password, salt, 64, options, (error, key) => error ? reject(error) : resolve(key)));
}
export async function hashPassword(password: string): Promise<string> {
  if (password.length < 12 || Buffer.byteLength(password) > 1024) throw new Error('Use a password between 12 characters and 1,024 bytes');
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt);
  return `scrypt$${salt}$${key.toString('hex')}`;
}
export async function verifyPassword(password: unknown, encoded: string): Promise<boolean> {
  if (typeof password !== 'string' || Buffer.byteLength(password) > 1024 || !isPasswordHash(encoded)) return false;
  const [, salt, digest] = encoded.split('$');
  const actual = await derive(password, salt!);
  return timingSafeEqual(actual, Buffer.from(digest!, 'hex'));
}
