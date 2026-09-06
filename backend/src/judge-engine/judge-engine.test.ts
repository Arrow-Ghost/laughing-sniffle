import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../storage/SqliteStorage.ts';
import { AIGateway } from '../ai/AIGateway.ts';
import { JudgeEngine } from './index.ts';
import { guardConfidence } from './confidence.ts';
import { createSession, createTranscriptSegment } from '../domain/entities.ts';
import { rubricFromPreset } from '../domain/rubrics.ts';
import type { SpeechSnapshot } from '../speech-core/index.ts';

const MODELS = { transcribe: ['t'], coach: ['c'], judge: ['j'], similarity: ['s'], summarize: ['sm'] };

function fakeSnapshot(wordCount: number, speakingSec: number): SpeechSnapshot {
  return {
    elapsedMs: (speakingSec + 20) * 1000,
    transcript: { text: 'x '.repeat(wordCount).trim(), wordCount, source: 'gemini' },
    pace: { wpm: 150, descriptor: 'steady', window: 'last 30s of speaking time', ready: true },
    pauses: { count: 3, meanMs: 900, longestMs: 1800 },
    fillers: { ready: true, hardPerMin: 2.1, softPerMin: 0.5, hardExamples: ['um'], softExamples: [], note: '' },
    vocabulary: { variety: 0.88, varietyBasis: 'MATTR-50', longWordRate: 0.18, distinctWords: 60, meanUnitLength: 14, meanUnitBasis: 'punctuation' },
    delivery: { talkRatio: 0.78, speakingSecondsTotal: speakingSec },
    answerLatency: { pending: false, latencyMs: 900 },
    timeline: [{ t: 1000, kind: 'question' }],
  };
}

function seedSession(s: SqliteStorage, words: number, speakingSec = 60) {
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 0, t1: 4000, text: 'Thank you chair. The core question is whether trade policy helps working people.', isFinal: true }));
  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 4000, t1: 12000, text: 'On balance it does not, because open markets without adjustment support concentrate the losses.', isFinal: true }));
  s.appendMetric({ id: 'm1', createdAt: Date.now(), sessionId: se.id, atMs: (speakingSec + 20) * 1000, kind: 'final', snapshot: fakeSnapshot(words, speakingSec) });
  return se;
}

const goodCriterionJson = (score: number) =>
  JSON.stringify({
    score,
    confidence: 'high',
    evidence: [{ startMs: 4000, endMs: 12000, quote: 'open markets without adjustment support concentrate the losses', reason: 'clear claim-impact link' }],
    strengths: ['direct thesis'],
    weaknesses: ['second point unsupported'],
    reasoning: 'A clear claim with a supporting mechanism; matches the "strong" anchor.',
  });

test('evaluate: one CriterionScore per rubric criterion, weighted overall, evidence + reasoning present', async () => {
  const s = new SqliteStorage(':memory:');
  const se = seedSession(s, 400, 90);
  const rubric = rubricFromPreset('debate');
  const ai = new AIGateway({ apiKey: '', models: MODELS, _call: async () => ({ text: goodCriterionJson(8) }) });
  const engine = new JudgeEngine(s, ai);

  const ev = await engine.evaluate({ sessionId: se.id, rubric });
  assert.equal(ev.criteria.length, rubric.criteria.length);
  assert.equal(ev.judgeType, 'ai');
  assert.equal(ev.status, 'draft');
  for (const c of ev.criteria) {
    assert.equal(c.aiScore, 8);
    assert.equal(c.humanScore, null);
    assert.ok(c.reasoning.length > 0);
    assert.ok(c.evidence.length >= 1);
  }
  assert.ok(Math.abs(ev.overallScore - 8) < 0.05, `overall ${ev.overallScore}`);
  // judge evidence mirrored onto the persisted timeline
  assert.ok(s.listTimeline(se.id).some((t) => t.source === 'judge'));
  s.close();
});

test('evaluate: confidence guard caps a short response', async () => {
  const s = new SqliteStorage(':memory:');
  const se = seedSession(s, 30, 12); // very short + little speaking time
  const ai = new AIGateway({ apiKey: '', models: MODELS, _call: async () => ({ text: goodCriterionJson(9) }) });
  const ev = await new JudgeEngine(s, ai).evaluate({ sessionId: se.id, rubric: rubricFromPreset('speech') });
  assert.ok(ev.criteria.every((c) => c.confidence === 'low'));
  assert.ok(ev.criteria[0]!.confidenceReasons.some((r) => /short response/.test(r)));
  assert.equal(ev.overallConfidence, 'low');
  s.close();
});

test('evaluate: a criterion whose AI call fails is left unscored (evaluated:false)', async () => {
  const s = new SqliteStorage(':memory:');
  const se = seedSession(s, 300, 80);
  let n = 0;
  const ai = new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async () => {
      n += 1;
      if (n === 2) throw new Error('ECONNRESET'); // fail the 2nd criterion
      return { text: goodCriterionJson(7) };
    },
  });
  const rubric = rubricFromPreset('interview');
  const ev = await new JudgeEngine(s, ai).evaluate({ sessionId: se.id, rubric });
  const failed = ev.criteria[1]!;
  assert.equal(failed.aiScore, null);
  assert.equal(failed.confidence, 'low');
  assert.ok(/unavailable/i.test(failed.confidenceReasons.join(' ')));

  // finalize is blocked until that criterion gets a human score
  assert.throws(() => new JudgeEngine(s, ai).finalize({ evaluationId: ev.id }), /no automated or human score/i);

  const engine = new JudgeEngine(s, ai);
  const after = engine.applyOverride({ evaluationId: ev.id, criterionId: failed.criterionId, humanScore: 6, reason: 'answer was adequate', reviewer: 'judge-1' });
  const csAfter = after.criteria[1]!;
  assert.equal(csAfter.humanScore, 6);
  assert.equal(csAfter.score, 6);
  assert.equal(csAfter.overriddenBy, 'judge-1');
  assert.equal(after.judgeType, 'human');

  const fin = engine.finalize({ evaluationId: ev.id, reviewer: 'judge-1', notes: 'agreed at panel' });
  assert.equal(fin.status, 'final');

  const actions = s.listAuditBySession(se.id).map((a) => a.action);
  assert.ok(actions.includes('evaluation.created'));
  assert.ok(actions.includes('evaluation.override'));
  assert.ok(actions.includes('evaluation.finalized'));
  s.close();
});

test('override keeps the AI score alongside the human score, and recomputes overall', async () => {
  const s = new SqliteStorage(':memory:');
  const se = seedSession(s, 400, 90);
  const ai = new AIGateway({ apiKey: '', models: MODELS, _call: async () => ({ text: goodCriterionJson(5) }) });
  const engine = new JudgeEngine(s, ai);
  const ev = await engine.evaluate({ sessionId: se.id, rubric: rubricFromPreset('debate') });
  assert.ok(Math.abs(ev.overallScore - 5) < 0.05);

  const target = ev.criteria[0]!; // Argumentation, weight 0.30
  const after = engine.applyOverride({ evaluationId: ev.id, criterionId: target.criterionId, humanScore: 9 });
  const cs = after.criteria[0]!;
  assert.equal(cs.aiScore, 5);
  assert.equal(cs.humanScore, 9);
  assert.ok(after.overallScore > 5.5, `overall moved to ${after.overallScore}`);
  // the human flag persists through a reload
  const reloaded = s.getEvaluation(ev.id)!;
  assert.equal(reloaded.judgeType, 'human');
  assert.equal(reloaded.criteria[0]!.humanScore, 9);
  assert.equal(reloaded.criteria[0]!.aiScore, 5);
  s.close();
});

test('a finalised evaluation cannot be overridden until reopened', async () => {
  const s = new SqliteStorage(':memory:');
  const se = seedSession(s, 400, 90);
  const ai = new AIGateway({ apiKey: '', models: MODELS, _call: async () => ({ text: goodCriterionJson(7) }) });
  const engine = new JudgeEngine(s, ai);
  const ev = await engine.evaluate({ sessionId: se.id, rubric: rubricFromPreset('debate') });
  engine.finalize({ evaluationId: ev.id });
  assert.throws(() => engine.applyOverride({ evaluationId: ev.id, criterionId: ev.criteria[0]!.criterionId, humanScore: 8 }), /finalised/);
  s.close();
});

test('evaluation carries no integrity signal (performance ≠ integrity, spec §101)', async () => {
  const s = new SqliteStorage(':memory:');
  const se = seedSession(s, 400, 90);
  const ai = new AIGateway({ apiKey: '', models: MODELS, _call: async () => ({ text: goodCriterionJson(8) }) });
  const ev = await new JudgeEngine(s, ai).evaluate({ sessionId: se.id, rubric: rubricFromPreset('debate') });
  const json = JSON.stringify(ev).toLowerCase();
  for (const banned of ['probability', 'ailikelihood', 'ai-likelihood', 'cheat', 'plagiar', 'integrity', 'verdict', '%']) {
    assert.ok(!json.includes(banned), `evaluation leaked "${banned}"`);
  }
  s.close();
});

test('guardConfidence unit rules', () => {
  assert.equal(guardConfidence('high', { wordCount: 500, speakingSeconds: 120, evidenceCount: 2, evaluated: true }).confidence, 'high');
  assert.equal(guardConfidence('high', { wordCount: 20, speakingSeconds: 120, evidenceCount: 2, evaluated: true }).confidence, 'low');
  assert.equal(guardConfidence('high', { wordCount: 300, speakingSeconds: 120, evidenceCount: 0, evaluated: true }).confidence, 'low');
  assert.equal(guardConfidence('high', { wordCount: 300, speakingSeconds: 10, evidenceCount: 2, evaluated: true }).confidence, 'medium');
  assert.deepEqual(guardConfidence('high', { wordCount: 0, speakingSeconds: 0, evidenceCount: 0, evaluated: false }), {
    confidence: 'low',
    reasons: ['automated evaluation unavailable'],
  });
});
