import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeStyleBaseline, styleDeviation, MIN_BASELINE_SESSIONS, metricsFromSnapshot } from './style.ts';
import type { SpeechSnapshot } from '../speech-core/index.ts';

function snap(over: Partial<{ wpm: number; variety: number; meanUnit: number; filler: number; pauses: number; words: number; ms: number }>): SpeechSnapshot {
  const o = { wpm: 150, variety: 0.85, meanUnit: 14, filler: 2, pauses: 6, words: 300, ms: 120_000, ...over };
  return {
    elapsedMs: o.ms,
    transcript: { text: 'x '.repeat(o.words), wordCount: o.words, source: 'gemini' },
    pace: { wpm: o.wpm, descriptor: 'steady', window: '', ready: true },
    pauses: { count: o.pauses, meanMs: 800, longestMs: 1500 },
    fillers: { ready: true, hardPerMin: o.filler, softPerMin: 0, hardExamples: [], softExamples: [], note: '' },
    vocabulary: { variety: o.variety, varietyBasis: 'MATTR-50', longWordRate: 0.18, distinctWords: 100, meanUnitLength: o.meanUnit, meanUnitBasis: 'punctuation' },
    delivery: { talkRatio: 0.78, speakingSecondsTotal: o.ms / 1000 - 20 },
    answerLatency: { pending: false, latencyMs: 800 },
    timeline: [],
  };
}

test('a baseline needs at least MIN_BASELINE_SESSIONS prior sessions', () => {
  const two = computeStyleBaseline('p1', [snap({}), snap({})]);
  assert.equal(two.sessionsUsed, 2);
  const d = styleDeviation(snap({ wpm: 300 }), { id: '', createdAt: 0, ...two });
  assert.equal(d.hasBaseline, false);
  assert.match(d.reasons[0]!, /insufficient history/);
});

test('short prior sessions (<40 words) are excluded from the baseline', () => {
  const b = computeStyleBaseline('p1', [snap({ words: 300 }), snap({ words: 20 }), snap({ words: 300 }), snap({ words: 10 })]);
  assert.equal(b.sessionsUsed, 2);
});

test('a large deviation from the speaker’s own norm is flagged, with the caveat', () => {
  const priors = [snap({}), snap({ wpm: 148 }), snap({ wpm: 152, variety: 0.86 })];
  const b = { id: '', createdAt: 0, ...computeStyleBaseline('p1', priors) };
  assert.ok(b.sessionsUsed >= MIN_BASELINE_SESSIONS);

  const shifted = styleDeviation(snap({ wpm: 240, variety: 0.55, filler: 0, meanUnit: 26 }), b);
  assert.equal(shifted.hasBaseline, true);
  assert.ok(shifted.overallShift > 0.3, `shift ${shifted.overallShift}`);
  assert.ok(shifted.reasons.length >= 1);
  assert.match(shifted.caveat, /noise|weak corroboration/i);

  const same = styleDeviation(snap({ wpm: 150 }), b);
  assert.ok(same.overallShift < 0.2);
  assert.equal(same.reasons.length, 0);
});

test('metricsFromSnapshot derives per-minute rates', () => {
  const m = metricsFromSnapshot(snap({ pauses: 12, ms: 120_000 }));
  assert.ok(Math.abs(m.pausesPerMin - 6) < 0.01);
});
