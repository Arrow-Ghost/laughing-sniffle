import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createEvent,
  createRound,
  createParticipant,
  createSession,
  createTranscriptSegment,
  normalizePolicy,
  ValidationError,
} from './entities.ts';

test('createEvent fills id/createdAt and defaults policy to prohibited', () => {
  const e = createEvent({ name: 'Regionals', type: 'debate' });
  assert.match(e.id, /^[0-9a-f-]{36}$/);
  assert.ok(e.createdAt > 0);
  assert.equal(e.status, 'draft');
  assert.equal(e.policy.aiAssistance, 'prohibited');
  assert.equal(e.policy.integrityReview, true);
});

test('createEvent rejects an unknown type', () => {
  assert.throws(() => createEvent({ name: 'x', type: 'karaoke' }), ValidationError);
});

test('normalizePolicy coerces partial input and rejects bad stances', () => {
  const p = normalizePolicy({ aiAssistance: 'allowed', internet: 'allowed', languages: ['en', 'hi'] });
  assert.equal(p.aiAssistance, 'allowed');
  assert.equal(p.preparedNotes, 'allowed'); // default
  assert.deepEqual(p.languages, ['en', 'hi']);
  assert.throws(() => normalizePolicy({ aiAssistance: 'maybe' }), ValidationError);
});

test('createSession enforces the consent gate (spec §3, §102)', () => {
  assert.throws(
    () => createSession({ mode: 'debate-practice', consent: {} }),
    (e: unknown) => e instanceof ValidationError && e.field === 'consent.speakerAcknowledged',
  );
  const s = createSession({ mode: 'interview-prep', consent: { speakerAcknowledged: true } });
  assert.equal(s.status, 'live');
  assert.equal(s.label, 'Interview prep');
  assert.equal(s.consent.secondPartyAcknowledged, false);
  assert.equal(s.eventId, null); // standalone practice
});

test('createRound requires a positive integer index', () => {
  assert.throws(() => createRound({ eventId: 'e1', index: 0 }), ValidationError);
  assert.throws(() => createRound({ eventId: 'e1', index: 1.5 }), ValidationError);
  assert.equal(createRound({ eventId: 'e1', index: 2 }).name, 'Round 2');
});

test('createParticipant allows a null event (standalone)', () => {
  const p = createParticipant({ displayName: 'Alex' });
  assert.equal(p.eventId, null);
  assert.equal(p.seat, null);
});

test('createTranscriptSegment validates source enum', () => {
  assert.throws(
    () => createTranscriptSegment({ sessionId: 's1', source: 'whisper' as never, t0: 0, t1: 1, text: 'hi', isFinal: true }),
    ValidationError,
  );
  const seg = createTranscriptSegment({ sessionId: 's1', source: 'gemini', t0: 0, t1: 1200, text: 'hi', isFinal: true });
  assert.equal(seg.lang, null);
});
