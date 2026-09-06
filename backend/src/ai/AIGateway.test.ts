import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AIGateway } from './AIGateway.ts';

const MODELS = {
  transcribe: ['m-transcribe'],
  coach: ['m-coach'],
  judge: ['m-judge'],
  similarity: ['m-sim'],
  summarize: ['m-sum'],
};

test('generateCoach: valid JSON on the first try', async () => {
  const ai = new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async () => ({ text: '{"summary":"Solid opening.","notes":["Clear signposting","Slow the close"]}' }),
  });
  const r = await ai.generateCoach({ transcript: 'x'.repeat(60), metrics: {} });
  assert.equal(r.summary, 'Solid opening.');
  assert.deepEqual(r.notes, ['Clear signposting', 'Slow the close']);
});

test('generateCoach: repairs a fenced/prosey reply, then succeeds', async () => {
  let n = 0;
  const ai = new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async () => {
      n += 1;
      return n === 1
        ? { text: 'Sure! Here are your notes:\n```\nnot json\n```' }
        : { text: '```json\n{"summary":"ok","notes":["a","b","c"]}\n```' };
    },
  });
  const r = await ai.generateCoach({ transcript: 'y'.repeat(60), metrics: {} });
  assert.equal(n, 2, 'should have retried once with the repair hint');
  assert.equal(r.summary, 'ok');
  assert.equal(r.notes.length, 3);
});

test('generateCoach: never throws — returns the typed fallback after two bad replies', async () => {
  const ai = new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async () => ({ text: 'still not json at all' }),
  });
  const r = await ai.generateCoach({ transcript: 'z'.repeat(60), metrics: {} });
  assert.equal(r.summary, 'Coaching notes are unavailable right now.');
  assert.deepEqual(r.notes, []);
});

test('generateCoach: transport error falls back without a second call', async () => {
  let n = 0;
  const ai = new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async () => {
      n += 1;
      throw new Error('ECONNRESET socket hang up');
    },
  });
  const r = await ai.generateCoach({ transcript: 'q'.repeat(60), metrics: {} });
  assert.equal(n, 1);
  assert.deepEqual(r.notes, []);
});

test('model fallback walks the list on a 404, then logs the successful model', async () => {
  const ai = new AIGateway({
    apiKey: '',
    models: { ...MODELS, transcribe: ['dead-model', 'live-model'] },
    _call: async (model) => {
      if (model === 'dead-model') throw new Error('[404 Not Found] model is no longer available');
      return { text: 'thank you chair', inputTokens: 10, outputTokens: 4 };
    },
  });
  const text = await ai.transcribe(Buffer.alloc(64000), 16_000);
  assert.equal(text, 'thank you chair');
  const ok = ai.log.filter((l) => l.ok);
  assert.equal(ok.at(-1)?.model, 'live-model');
  assert.ok(ai.costSummary().estCostUsd >= 0);
});

const CRITERION = {
  id: 'c1',
  name: 'Rebuttal',
  weight: 0.2,
  description: 'engagement with the opponent',
  scaleMin: 1,
  scaleMax: 10,
  anchors: { '1': 'weak', '10': 'exceptional' },
  evaluationRules: 'address the strongest point',
  dimension: null,
};

test('judgeCriterion: valid JSON → evaluated, score clamped to the scale', async () => {
  const ai = new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async () => ({
      text: '{"score": 14, "confidence":"high", "evidence":[{"startMs":1000,"endMs":2000,"quote":"q","reason":"r"}], "strengths":[], "weaknesses":[], "reasoning":"ok"}',
    }),
  });
  const r = await ai.judgeCriterion({ criterion: CRITERION, eventType: 'debate', transcriptLines: '[00:01] q', metricsDigest: 'x', timelineDigest: '' });
  assert.equal(r.evaluated, true);
  assert.equal(r.score, 10, 'clamped to scaleMax');
  assert.equal(r.confidence, 'high');
  assert.equal(r.evidence.length, 1);
});

test('judgeCriterion: two malformed replies → typed unevaluated fallback', async () => {
  const ai = new AIGateway({ apiKey: '', models: MODELS, _call: async () => ({ text: 'no json here' }) });
  const r = await ai.judgeCriterion({ criterion: CRITERION, eventType: 'debate', transcriptLines: 'x', metricsDigest: 'x', timelineDigest: '' });
  assert.equal(r.evaluated, false);
  assert.equal(r.score, CRITERION.scaleMin);
  assert.equal(r.confidence, 'low');
  assert.match(r.reasoning, /unavailable/i);
});

test('cost summary aggregates tokens across calls', async () => {
  const ai = new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async () => ({ text: '{"summary":"s","notes":["a","b","c"]}', inputTokens: 100, outputTokens: 50 }),
  });
  await ai.generateCoach({ transcript: 'a'.repeat(60), metrics: {} });
  const c = ai.costSummary();
  assert.equal(c.calls, 1);
  assert.equal(c.inputTokens, 100);
  assert.equal(c.outputTokens, 50);
});
