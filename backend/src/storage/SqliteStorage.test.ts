import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from './SqliteStorage.ts';
import {
  createEvent,
  createRound,
  createParticipant,
  createSession,
  createTranscriptSegment,
  createAuditEvent,
} from '../domain/entities.ts';

function fresh() {
  return new SqliteStorage(':memory:');
}

test('event round-trips with its policy JSON intact', () => {
  const s = fresh();
  const e = s.createEvent(createEvent({ name: 'Nats SF', type: 'debate', policy: { aiAssistance: 'disclosure' } }));
  const back = s.getEvent(e.id);
  assert.equal(back?.name, 'Nats SF');
  assert.equal(back?.policy.aiAssistance, 'disclosure');
  s.setEventStatus(e.id, 'active');
  assert.equal(s.getEvent(e.id)?.status, 'active');
  s.close();
});

test('rounds and participants list by event in order', () => {
  const s = fresh();
  const e = s.createEvent(createEvent({ name: 'E', type: 'debate' }));
  s.createRound(createRound({ eventId: e.id, index: 2 }));
  s.createRound(createRound({ eventId: e.id, index: 1 }));
  s.createParticipant(createParticipant({ eventId: e.id, displayName: 'A' }));
  s.createParticipant(createParticipant({ eventId: e.id, displayName: 'B' }));
  assert.deepEqual(s.listRoundsByEvent(e.id).map((r) => r.index), [1, 2]);
  assert.equal(s.listParticipantsByEvent(e.id).length, 2);
  s.close();
});

test('session lifecycle: create → segments/metrics → end', () => {
  const s = fresh();
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  assert.equal(s.getSession(se.id)?.status, 'live');

  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 0, t1: 3000, text: 'Chair, thank you.', isFinal: true }));
  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 3000, t1: 7000, text: 'My first point is', isFinal: true }));
  assert.equal(s.listSegments(se.id).length, 2);
  assert.equal(s.listSegments(se.id)[0]?.text, 'Chair, thank you.');

  s.appendMetric({ id: 'm1', createdAt: Date.now(), sessionId: se.id, atMs: 5000, kind: 'periodic', snapshot: { pace: { wpm: 130 } } });
  s.appendMetric({ id: 'm2', createdAt: Date.now(), sessionId: se.id, atMs: 9000, kind: 'final', snapshot: { pace: { wpm: 142 } } });
  assert.equal((s.latestMetric(se.id)?.snapshot as { pace: { wpm: number } }).pace.wpm, 142);

  s.endSession(se.id, Date.now());
  assert.equal(s.getSession(se.id)?.status, 'ended');
  assert.ok((s.getSession(se.id)?.endedAt ?? 0) > 0);
  s.close();
});

test('audit trail is append-only and ordered', () => {
  const s = fresh();
  const se = s.createSession(createSession({ mode: 'speech-coaching', consent: { speakerAcknowledged: true } }));
  s.appendAudit(createAuditEvent({ action: 'session.started', objectType: 'session', objectId: se.id, sessionId: se.id }));
  s.appendAudit(createAuditEvent({ action: 'session.ended', objectType: 'session', objectId: se.id, sessionId: se.id }));
  assert.deepEqual(s.listAuditBySession(se.id).map((a) => a.action), ['session.started', 'session.ended']);
  s.close();
});

test('listSessions can filter by event and respects a limit', () => {
  const s = fresh();
  const e = s.createEvent(createEvent({ name: 'E', type: 'interview' }));
  for (let i = 0; i < 3; i += 1) {
    s.createSession(createSession({ mode: 'interview-prep', consent: { speakerAcknowledged: true }, eventId: e.id }));
  }
  s.createSession(createSession({ mode: 'interview-prep', consent: { speakerAcknowledged: true } })); // no event
  assert.equal(s.listSessions({ eventId: e.id }).length, 3);
  assert.equal(s.listSessions({ limit: 2 }).length, 2);
  s.close();
});
