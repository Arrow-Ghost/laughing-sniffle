// Password hashing with Node's built-in scrypt — no external dependency.

import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;
const COST = 16_384; // N

export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(password, salt, KEYLEN, { N: COST });
  return `scrypt$${COST}$${salt.toString('hex')}$${dk.toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$');
  if (parts.length !== 4 || parts[0] !== 'scrypt') return false;
  const cost = Number(parts[1]);
  const salt = Buffer.from(parts[2]!, 'hex');
  const expected = Buffer.from(parts[3]!, 'hex');
  const dk = scryptSync(password, salt, expected.length, { N: cost });
  return dk.length === expected.length && timingSafeEqual(dk, expected);
}
