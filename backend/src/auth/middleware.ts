// Express auth middleware. When AUTH_SECRET is unset (dev), every request runs
// as a synthetic admin so the reflection console and the existing test surface
// keep working untouched. When it IS set, a valid signed token is required and
// role reach is enforced.

import type { NextFunction, Request, Response } from 'express';
import { HttpError } from '../errors.ts';
import { config } from '../config.ts';
import type { StorageProvider } from '../storage/StorageProvider.ts';
import { roleSatisfies, type Role } from './users.ts';
import { verifyToken } from './tokens.ts';

export interface AuthContext {
  userId: string;
  role: Role;
  participantId: string | null;
  dev: boolean;
}

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

const DEV_ADMIN: AuthContext = { userId: 'dev', role: 'admin', participantId: null, dev: true };

export const authEnabled = (): boolean => config.authSecret.length > 0;

function tokenFrom(req: Request): string | null {
  const h = req.header('authorization');
  if (h && h.toLowerCase().startsWith('bearer ')) return h.slice(7).trim();
  const cookie = req.header('cookie');
  const m = cookie ? /(?:^|;\s*)shadowadj_token=([^;]+)/.exec(cookie) : null;
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Resolve the auth context for a request (or null if unauthenticated & auth is on). */
export function contextFor(req: Request, storage: StorageProvider): AuthContext | null {
  if (!authEnabled()) return DEV_ADMIN;
  const tok = tokenFrom(req);
  if (!tok) return null;
  const payload = verifyToken(tok, config.authSecret);
  if (!payload) return null;
  // The user must still exist (revocation).
  const user = storage.getUser(payload.userId);
  if (!user) return null;
  return { userId: user.id, role: user.role, participantId: user.participantId, dev: false };
}

/** Middleware factory: require an authenticated user whose role reaches `need`. */
export function requireRole(storage: StorageProvider, need: Role) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const ctx = contextFor(req, storage);
    if (!ctx) return next(new HttpError(401, 'authentication required'));
    if (!roleSatisfies(ctx.role, need)) return next(new HttpError(403, `this action needs the ${need} role`));
    req.auth = ctx;
    next();
  };
}

/** Attach the auth context if present, but don't require it. */
export function attachAuth(storage: StorageProvider) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    req.auth = contextFor(req, storage) ?? undefined;
    next();
  };
}
