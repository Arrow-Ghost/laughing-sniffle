import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../storage/SqliteStorage.ts';
import { IntegrityEngine } from './index.ts';
import { MockSourceSearchProvider } from './source-search/MockSourceSearchProvider.ts';
import { createEvent, createParticipant, createSession, createTranscriptSegment } from '../domain/entities.ts';
import type { EventPolicy } from '../domain/types.ts';
import type { SpeechSnapshot } from '../speech-core/index.ts';

function fresh() {
  const s = new SqliteStorage(':memory:');
  return { s, engine: new IntegrityEngine(s, new MockSourceSearchProvider()) };
}

function allKeys(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, acc));
  else if (v && typeof v === 'object') for (const [k, val] of Object.entries(v)) {
    acc.add(k);
    allKeys(val, acc);
  }
  return acc;
}

function fakeSnap(o: Partial<{ wpm: number; variety: number; filler: number; pauses: number; talk: number; words: number; meanUnit: number }> = {}): SpeechSnapshot {
  const x = { wpm: 150, variety: 0.85, filler: 3, pauses: 12, talk: 0.72, words: 300, meanUnit: 14, ...o };
  return {
    elapsedMs: 180_000,
    transcript: { text: 'x '.repeat(x.words), wordCount: x.words, source: 'gemini' },
    pace: { wpm: x.wpm, descriptor: 'steady', window: '', ready: true },
    pauses: { count: x.pauses, meanMs: 800, longestMs: 1500 },
    fillers: { ready: true, hardPerMin: x.filler, softPerMin: 0, hardExamples: [], softExamples: [], note: '' },
    vocabulary: { variety: x.variety, varietyBasis: 'MATTR-50', longWordRate: 0.18, distinctWords: 100, meanUnitLength: x.meanUnit, meanUnitBasis: 'punctuation' },
    delivery: { talkRatio: x.talk, speakingSecondsTotal: 150 },
    answerLatency: { pending: false, latencyMs: 800 },
    timeline: [],
  };
}

function seed(s: SqliteStorage, transcripts: Record<string, string>, policy?: Partial<EventPolicy>) {
  const ev = s.createEvent(createEvent({ name: 'E', type: 'debate', policy }));
  const ids: Record<string, string> = {};
  for (const [label, text] of Object.entries(transcripts)) {
    const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, eventId: ev.id }));
    s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 0, t1: 8000, text, isFinal: true }));
    s.endSession(se.id, Date.now());
    ids[label] = se.id;
  }
  return { eventId: ev.id, ids };
}

function seedHistory(s: SqliteStorage, eventId: string, participantId: string, snaps: SpeechSnapshot[]) {
  for (const snap of snaps) {
    const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, eventId, participantId }));
    s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 0, t1: 8000, text: 'x '.repeat(snap.transcript.wordCount), isFinal: true }));
    s.appendMetric({ id: `${se.id}-m`, createdAt: Date.now(), sessionId: se.id, atMs: 180_000, kind: 'final', snapshot: snap });
    s.endSession(se.id, Date.now());
  }
}

const DISTINCTIVE_NO_ATTRIB =
  'Carbon markets collapse when regulatory credibility erodes under political pressure. ' +
  'When economies open to trade without adjustment assistance for displaced workers, the losses are concentrated in specific communities.';

test('style discontinuity: present on a big shift from the speaker own norm, but never escalates alone (spec 37)', async () => {
  const { s, engine } = fresh();
  const ev = s.createEvent(createEvent({ name: 'E', type: 'debate' }));
  const p = s.createParticipant(createParticipant({ eventId: ev.id, displayName: 'Alex' }));
  seedHistory(s, ev.id, p.id, [fakeSnap(), fakeSnap({ wpm: 148 }), fakeSnap({ wpm: 152 })]);

  const cur = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, eventId: ev.id, participantId: p.id }));
  s.appendSegment(createTranscriptSegment({ sessionId: cur.id, source: 'gemini', t0: 0, t1: 8000, text: 'An entirely ordinary practice answer with nothing lifted from anywhere.', isFinal: true }));
  s.appendMetric({ id: 'cur-m', createdAt: Date.now(), sessionId: cur.id, atMs: 180_000, kind: 'final', snapshot: fakeSnap({ wpm: 260, variety: 0.5, filler: 0, meanUnit: 30 }) });
  s.endSession(cur.id, Date.now());

  const { case: c } = await engine.analyzeSession(cur.id);
  const sig = c!.signals.find((g) => g.key === 'style-discontinuity')!;
  assert.equal(c!.styleAnalysis!.hasBaseline, true);
  assert.equal(sig.present, true);
  assert.equal(sig.origin, 'style-baseline');
  assert.equal(c!.riskLevel, 'LOW');
  s.close();
});

test('"prepared" is not an AI signal by itself (spec 38)', async () => {
  const { s, engine } = fresh();
  const rehearsed = 'This is my prepared closing, fluent and well organised and entirely my own work, delivered from memory after weeks of drilling with my squad.';

  const a = seed(s, { x: rehearsed }, { preparedNotes: 'allowed' });
  const r1 = await engine.analyzeSession(a.ids.x!);
  assert.equal(r1.case!.signals.find((g) => g.key === 'preparedness-under-prohibition')!.present, false);

  const b = seed(s, { y: rehearsed }, { preparedNotes: 'prohibited' });
  const r2 = await engine.analyzeSession(b.ids.y!);
  assert.equal(r2.case!.signals.find((g) => g.key === 'preparedness-under-prohibition')!.present, false);
  assert.equal(r2.case!.riskLevel, 'LOW');
  s.close();
});

test('session-integrity anomaly attaches as a signal and is never called "tampered"', async () => {
  const { s, engine } = fresh();
  const ev = s.createEvent(createEvent({ name: 'E', type: 'debate' }));
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, eventId: ev.id }));
  const line = 'A distinctive sentence recorded for the session log, then recorded once more.';
  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 0, t1: 5000, text: line, isFinal: true }));
  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 5000, t1: 10000, text: line, isFinal: true }));
  s.endSession(se.id, Date.now());

  const { case: c } = await engine.analyzeSession(se.id);
  assert.ok(c!.sessionIntegrity.anomalies.some((a) => a.type === 'duplicated-segment'));
  assert.equal(c!.signals.find((g) => g.key === 'session-integrity-anomaly')!.present, true);
  assert.doesNotMatch(JSON.stringify(c!.sessionIntegrity), /tampered|cheat|guilty|falsif/i);
  s.close();
});

test('appeal flow: submit then respond upheld clears the case; a confirmed case is not moved by an appeal', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, { x: DISTINCTIVE_NO_ATTRIB });
  const { case: c } = await engine.analyzeSession(ids.x!);

  assert.throws(() => engine.appeal({ caseId: c!.id, submittedBy: '', statement: 'x' }), /required/);
  const ap = engine.appeal({ caseId: c!.id, submittedBy: 'participant-7', statement: 'That phrasing is common in policy debate; I consulted no source.' });
  assert.equal(ap.response, null);

  assert.throws(() => engine.respondAppeal({ appealId: ap.id, reviewerId: '', decision: 'upheld', reason: 'x' }), /reviewerId/);
  engine.respondAppeal({ appealId: ap.id, reviewerId: 'ombuds', decision: 'upheld', reason: 'agreed, common knowledge' });
  assert.equal(s.getIntegrityCase(c!.id)!.status, 'dismissed');

  const actions = s.listAuditBySession(ids.x!).map((a) => a.action);
  assert.ok(actions.includes('integrity.appeal.submitted') && actions.includes('integrity.appeal.responded'));

  const { ids: ids2 } = seed(s, { y: DISTINCTIVE_NO_ATTRIB });
  const { case: c2 } = await engine.analyzeSession(ids2.y!);
  engine.review({ caseId: c2!.id, reviewerId: 'chief', decision: 'confirm', reason: 'verbatim and unattributed' });
  const ap2 = engine.appeal({ caseId: c2!.id, submittedBy: 'participant-8', statement: 'please reconsider' });
  engine.respondAppeal({ appealId: ap2.id, reviewerId: 'ombuds', decision: 'upheld', reason: 'sympathetic' });
  assert.equal(s.getIntegrityCase(c2!.id)!.status, 'confirmed');
  s.close();
});

test('participant-facing view hides internal weighting and other participants identities (spec 43, 79)', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, {
    x: DISTINCTIVE_NO_ATTRIB,
    y: 'Aside from the intro. ' + DISTINCTIVE_NO_ATTRIB + ' And that is the case.',
  });
  const { case: c } = await engine.analyzeSession(ids.x!);
  const view = engine.redactedCase(c!.id);
  const keys = allKeys(view);
  for (const hidden of ['strength', 'origin', 'otherSessionId', 'otherLabel', 'sharedDistinctivePhrases', 'internalScore', 'probability']) {
    assert.ok(!keys.has(hidden), `participant view leaked "${hidden}"`);
  }
  s.close();
});

test('source graph is a clean derived view over the case', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, { x: DISTINCTIVE_NO_ATTRIB, y: 'Aside. ' + DISTINCTIVE_NO_ATTRIB + ' Done.' });
  const { case: c } = await engine.analyzeSession(ids.x!);
  const g = engine.sourceGraph(c!.id);
  assert.equal(g.nodes.find((n) => n.kind === 'participant')?.id, 'participant');
  assert.ok(g.nodes.some((n) => n.kind === 'source'));
  assert.ok(g.edges.every((e) => e.from === 'participant' && e.weight >= 0 && e.weight <= 1));
  s.close();
});

test('Phase 4 fields do not smuggle a probability or score into the case', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, { x: DISTINCTIVE_NO_ATTRIB });
  const { case: c } = await engine.analyzeSession(ids.x!);
  const keys = allKeys(c);
  for (const banned of ['probability', 'percent', 'internalScore', 'overallScore', 'score', 'aiLikelihood', 'rubricId']) {
    assert.ok(!keys.has(banned), `case leaked "${banned}"`);
  }
  s.close();
});
