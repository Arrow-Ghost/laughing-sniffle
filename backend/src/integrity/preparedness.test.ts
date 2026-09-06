import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzePreparedness } from './preparedness.ts';
import type { SpeechSnapshot } from '../speech-core/index.ts';

function snap(over: Partial<{ filler: number; pauses: number; talk: number; words: number; desc: string; variety: number; paceShifts: number }>): SpeechSnapshot {
  const o = { filler: 3, pauses: 12, talk: 0.7, words: 300, desc: 'steady', variety: 0.85, paceShifts: 0, ...over };
  return {
    elapsedMs: 180_000,
    transcript: { text: 'x '.repeat(o.words), wordCount: o.words, source: 'gemini' },
    pace: { wpm: 150, descriptor: o.desc as any, window: '', ready: true },
    pauses: { count: o.pauses, meanMs: 800, longestMs: 1500 },
    fillers: { ready: true, hardPerMin: o.filler, softPerMin: 0, hardExamples: [], softExamples: [], note: '' },
    vocabulary: { variety: o.variety, varietyBasis: 'MATTR-50', longWordRate: 0.18, distinctWords: 100, meanUnitLength: 14, meanUnitBasis: 'punctuation' },
    delivery: { talkRatio: o.talk, speakingSecondsTotal: 150 },
    answerLatency: { pending: false, latencyMs: 800 },
    timeline: Array.from({ length: o.paceShifts }, () => ({ t: 0, kind: 'pace-fast' })),
  };
}

test('a fluent, low-hesitation, sustained delivery reads as rehearsed', () => {
  const p = analyzePreparedness(snap({ filler: 0.3, pauses: 3, talk: 0.92, desc: 'steady', paceShifts: 0 }));
  assert.ok(['prepared', 'highly-rehearsed'].includes(p.classification), p.classification);
  assert.ok(p.rehearsedScore >= 0.6);
  assert.match(p.note, /not evidence of unauthorised assistance/i);
});

test('a hesitant, pause-heavy delivery reads as spontaneous', () => {
  const p = analyzePreparedness(snap({ filler: 8, pauses: 30, talk: 0.55, desc: 'measured', paceShifts: 3 }));
  assert.equal(p.classification, 'spontaneous');
  assert.ok(p.rehearsedScore < 0.4);
});

test('too little speech → uncertain', () => {
  assert.equal(analyzePreparedness(snap({ words: 20 })).classification, 'uncertain');
});
