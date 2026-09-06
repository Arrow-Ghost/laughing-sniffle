// Stateless signed session tokens — HMAC-SHA256 over a compact JSON payload.
// No JWT library; the format is `base64url(payload).base64url(sig)`.

import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Role } from './users.ts';

export interface TokenPayload {
  userId: string;
  role: Role;
  participantId: string | null;
  exp: number; // epoch ms
}

const b64u = (b: Buffer): string => b.toString('base64url');
const fromB64u = (s: string): Buffer => Buffer.from(s, 'base64url');

export function signToken(payload: TokenPayload, secret: string): string {
  const body = b64u(Buffer.from(JSON.stringify(payload)));
  const sig = b64u(createHmac('sha256', secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken(token: string, secret: string): TokenPayload | null {
  const dot = token.lastIndexOf('.');
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = createHmac('sha256', secret).update(body).digest();
  let given: Buffer;
  try {
    given = fromB64u(sig);
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const payload = JSON.parse(fromB64u(body).toString()) as TokenPayload;
    if (typeof payload.exp !== 'number' || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12h
