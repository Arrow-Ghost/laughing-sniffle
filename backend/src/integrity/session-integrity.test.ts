import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSessionIntegrity, computeArtifactHashes } from './session-integrity.ts';
import { createTranscriptSegment } from '../domain/entities.ts';
import type { SessionArtifacts, TranscriptSegment } from '../domain/types.ts';

function seg(t0: number, t1: number, text: string): TranscriptSegment {
  return createTranscriptSegment({ sessionId: 's1', source: 'gemini', t0, t1, text, isFinal: true });
}

const clean = [seg(0, 4000, 'Thank you chair and good evening to the panel.'), seg(4000, 9000, 'My first substantive point concerns trade adjustment.')];

test('computeArtifactHashes is deterministic and order-sensitive', () => {
  const a = computeArtifactHashes({ segments: clean, snapshot: { x: 1 }, timeline: [] });
  const b = computeArtifactHashes({ segments: [...clean], snapshot: { x: 1 }, timeline: [] });
  assert.equal(a.transcriptHash, b.transcriptHash);
  const c = computeArtifactHashes({ segments: [...clean].reverse(), snapshot: { x: 1 }, timeline: [] });
  assert.notEqual(a.transcriptHash, c.transcriptHash);
});

test('a clean session produces no anomalies', () => {
  const r = checkSessionIntegrity({ segments: clean, snapshot: null, timeline: [], artifacts: null, reconnects: 0, audioGaps: [] });
  assert.equal(r.anomalies.length, 0);
  assert.equal(r.hashed, false);
  assert.match(r.note, /cannot be made tamper-proof/i);
});

test('a post-hoc transcript edit is caught by the stored hash', () => {
  const hashes = computeArtifactHashes({ segments: clean, snapshot: null, timeline: [] });
  const artifacts: SessionArtifacts = {
    id: 'a1', createdAt: 0, sessionId: 's1', ...hashes, segmentCount: 2, audioMsTotal: 9000, reconnects: 0,
  };
  const tampered = [seg(0, 4000, 'Thank you chair and good evening to the panel and also the sponsors.'), clean[1]!];
  const r = checkSessionIntegrity({ segments: tampered, snapshot: null, timeline: [], artifacts, reconnects: 0, audioGaps: [] });
  assert.ok(r.anomalies.some((a) => a.type === 'hash-mismatch'));
  // it is called an anomaly, never "tampered" / "cheated"
  assert.doesNotMatch(JSON.stringify(r), /tampered|cheat|falsif/i);
});

test('duplicated segment and impossible timing are flagged as anomalies', () => {
  const dup = [seg(0, 4000, 'This is a distinctive opening line for the record.'), seg(4000, 8000, 'This is a distinctive opening line for the record.')];
  const r1 = checkSessionIntegrity({ segments: dup, snapshot: null, timeline: [], artifacts: null, reconnects: 0, audioGaps: [] });
  assert.ok(r1.anomalies.some((a) => a.type === 'duplicated-segment'));

  const fast = [seg(0, 1000, 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen')];
  const r2 = checkSessionIntegrity({ segments: fast, snapshot: null, timeline: [], artifacts: null, reconnects: 0, audioGaps: [] });
  assert.ok(r2.anomalies.some((a) => a.type === 'timing-inconsistent-with-audio'));
});

test('mid-session reconnects and audio gaps are recorded, not judged', () => {
  const r = checkSessionIntegrity({
    segments: clean,
    snapshot: null,
    timeline: [],
    artifacts: null,
    reconnects: 3,
    audioGaps: [{ atMs: 12000, durMs: 9000 }],
  });
  assert.ok(r.anomalies.some((a) => a.type === 'reconnect'));
  assert.ok(r.anomalies.some((a) => a.type === 'audio-stream-gap'));
  assert.ok(r.anomalies.every((a) => ['info', 'notable', 'concern'].includes(a.severity)));
});
