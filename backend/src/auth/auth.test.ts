import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from './hash.ts';
import { signToken, verifyToken, TOKEN_TTL_MS } from './tokens.ts';
import { createUser, roleSatisfies, publicUser, ROLES } from './users.ts';
import { SqliteStorage } from '../storage/SqliteStorage.ts';

test('hash: verifies the right password and rejects the wrong one', () => {
  const stored = hashPassword('correct horse battery');
  assert.ok(stored.startsWith('scrypt$'));
  assert.equal(verifyPassword('correct horse battery', stored), true);
  assert.equal(verifyPassword('Correct horse battery', stored), false);
  assert.equal(verifyPassword('', stored), false);
});

test('hash: two hashes of the same password differ (salted)', () => {
  assert.notEqual(hashPassword('same'), hashPassword('same'));
});

test('hash: a malformed stored value never throws, just returns false', () => {
  assert.equal(verifyPassword('x', 'not-a-hash'), false);
  assert.equal(verifyPassword('x', 'scrypt$16384$deadbeef'), false);
});

test('token: sign then verify round-trips the payload', () => {
  const secret = 'shhh';
  const exp = Date.now() + TOKEN_TTL_MS;
  const tok = signToken({ userId: 'u1', role: 'reviewer', participantId: null, exp }, secret);
  const back = verifyToken(tok, secret);
  assert.equal(back?.userId, 'u1');
  assert.equal(back?.role, 'reviewer');
});

test('token: a wrong secret fails verification', () => {
  const tok = signToken({ userId: 'u1', role: 'judge', participantId: null, exp: Date.now() + 1000 }, 'a');
  assert.equal(verifyToken(tok, 'b'), null);
});

test('token: a tampered body fails verification', () => {
  const tok = signToken({ userId: 'u1', role: 'participant', participantId: null, exp: Date.now() + 1000 }, 's');
  const [, sig] = tok.split('.');
  const forged = Buffer.from(JSON.stringify({ userId: 'u1', role: 'admin', participantId: null, exp: Date.now() + 1000 })).toString('base64url');
  assert.equal(verifyToken(`${forged}.${sig}`, 's'), null);
});

test('token: an expired token fails verification', () => {
  const tok = signToken({ userId: 'u1', role: 'admin', participantId: null, exp: Date.now() - 1 }, 's');
  assert.equal(verifyToken(tok, 's'), null);
});

test('roleSatisfies: reach is admin > reviewer > judge > participant', () => {
  assert.equal(roleSatisfies('admin', 'reviewer'), true);
  assert.equal(roleSatisfies('reviewer', 'judge'), true);
  assert.equal(roleSatisfies('judge', 'participant'), true);
  assert.equal(roleSatisfies('participant', 'judge'), false);
  assert.equal(roleSatisfies('judge', 'reviewer'), false);
  for (const r of ROLES) assert.equal(roleSatisfies(r, r), true);
});

test('createUser: rejects a short password, defaults to participant, lowercases email', () => {
  assert.throws(() => createUser({ name: 'A', password: 'short' }));
  assert.throws(() => createUser({ name: '', password: 'longenough' }));
  const u = createUser({ name: '  Dana  ', password: 'longenough', email: 'Dana@Example.COM' });
  assert.equal(u.role, 'participant');
  assert.equal(u.name, 'Dana');
  assert.equal(u.email, 'dana@example.com');
  assert.ok(!('passwordHash' in publicUser(u)));
});

test('storage: user CRUD round-trips and enforces unique email', () => {
  const s = new SqliteStorage(':memory:');
  assert.equal(s.countUsers(), 0);
  const u = createUser({ name: 'Admin', password: 'longenough', email: 'a@b.com', role: 'admin' });
  s.createUser(u);
  assert.equal(s.countUsers(), 1);
  assert.equal(s.getUser(u.id)?.role, 'admin');
  assert.equal(s.getUserByEmail('a@b.com')?.id, u.id);
  assert.equal(s.getUserByEmail('missing@b.com'), null);
  assert.throws(() => s.createUser(createUser({ name: 'Dup', password: 'longenough', email: 'a@b.com' })));
  s.close();
});
