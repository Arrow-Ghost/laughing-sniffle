import { randomUUID } from 'node:crypto';
import { ValidationError } from '../domain/entities.ts';
import type { Entity, Id } from '../domain/types.ts';
import { hashPassword } from './hash.ts';

export type Role = 'admin' | 'judge' | 'reviewer' | 'participant';
export const ROLES: readonly Role[] = ['admin', 'judge', 'reviewer', 'participant'];

/** Role reach — an admin satisfies any requirement, a reviewer satisfies judge/participant, etc. */
const REACH: Record<Role, Role[]> = {
  admin: ['admin', 'judge', 'reviewer', 'participant'],
  reviewer: ['reviewer', 'judge', 'participant'],
  judge: ['judge', 'participant'],
  participant: ['participant'],
};

export function roleSatisfies(has: Role, needs: Role): boolean {
  return REACH[has].includes(needs);
}

export interface User extends Entity {
  name: string;
  email: string | null;
  role: Role;
  participantId: Id | null;
  passwordHash: string;
}

export function createUser(input: {
  name: unknown;
  password: unknown;
  role?: unknown;
  email?: unknown;
  participantId?: Id | null;
}): User {
  if (typeof input.name !== 'string' || !input.name.trim()) throw new ValidationError('name', 'required');
  if (typeof input.password !== 'string' || input.password.length < 8) {
    throw new ValidationError('password', 'must be at least 8 characters');
  }
  const role = ROLES.includes(input.role as Role) ? (input.role as Role) : 'participant';
  return {
    id: randomUUID(),
    createdAt: Date.now(),
    name: input.name.trim().slice(0, 120),
    email: typeof input.email === 'string' && input.email.trim() ? input.email.trim().toLowerCase().slice(0, 200) : null,
    role,
    participantId: input.participantId ?? null,
    passwordHash: hashPassword(input.password),
  };
}

export function publicUser(u: User): Omit<User, 'passwordHash'> {
  const { passwordHash: _omit, ...rest } = u;
  return rest;
}
