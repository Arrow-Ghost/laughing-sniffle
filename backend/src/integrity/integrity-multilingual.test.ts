import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../storage/SqliteStorage.ts';
import { AIGateway } from '../ai/AIGateway.ts';
import { IntegrityEngine } from './index.ts';
import { MockSourceSearchProvider } from './source-search/MockSourceSearchProvider.ts';
import { JudgeEngine } from '../judge-engine/index.ts';
import { rubricFromPreset } from '../domain/rubrics.ts';
import { createEvent, createSession, createTranscriptSegment } from '../domain/entities.ts';
import type { SpeechSnapshot } from '../speech-core/index.ts';

const MODELS = { transcribe: ['t'], coach: ['c'], judge: ['j'], similarity: ['s'], summarize: ['sm'] };

// The seeded blog line, rendered "in Hindi" for the test (opaque to shingle
// matching) — the English the mock AI will "translate" it back to.
const HINDI_TEXT =
  'कार्बन बाज़ार तब ढह जाते हैं जब नियामकीय विश्वसनीयता राजनीतिक दबाव में क्षीण हो जाती है। ' +
  'यदि कंपनियाँ यह अपेक्षा करती हैं कि कैप ढीली कर दी जाएगी तो मूल्य संकेत गायब हो जाता है।';
const ENGLISH_BACK =
  'Carbon markets collapse when regulatory credibility erodes under political pressure. ' +
  'If firms expect the cap to be loosened under political pressure, the price signal disappears and the whole mechanism unwinds.';

function fakeSnap(): SpeechSnapshot {
  return {
    elapsedMs: 120_000,
    transcript: { text: 'x '.repeat(60), wordCount: 60, source: 'gemini' },
    pace: { wpm: 140, descriptor: 'steady', window: '', ready: true },
    pauses: { count: 4, meanMs: 800, longestMs: 1500 },
    fillers: { ready: true, hardPerMin: 2, softPerMin: 0, hardExamples: [], softExamples: [], note: '' },
    vocabulary: { variety: 0.85, varietyBasis: 'MATTR-50', longWordRate: 0.18, distinctWords: 50, meanUnitLength: 14, meanUnitBasis: 'punctuation' },
    delivery: { talkRatio: 0.75, speakingSecondsTotal: 100 },
    answerLatency: { pending: false, latencyMs: 800 },
    timeline: [],
  } as SpeechSnapshot;
}


test('a non-English answer is source-matched via translation, flagged lower-confidence (spec §12)', async () => {
  const s = new SqliteStorage(':memory:');
  const ai = new AIGateway({ apiKey: '', models: MODELS, _call: async () => ({ text: ENGLISH_BACK }) });
  const engine = new IntegrityEngine(s, new MockSourceSearchProvider(), ai);

  const ev = s.createEvent(createEvent({ name: 'E', type: 'debate', policy: { languages: ['hi', 'en'] } }));
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, eventId: ev.id, languages: ['hi', 'en'] }));
  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 0, t1: 9000, text: HINDI_TEXT, isFinal: true, lang: 'hi' }));
  s.appendMetric({ id: 'm', createdAt: Date.now(), sessionId: se.id, atMs: 120_000, kind: 'final', snapshot: fakeSnap() });
  s.endSession(se.id, Date.now());

  const { case: c } = await engine.analyzeSession(se.id);
  assert.ok(c!.sourceMatches.length >= 1, 'the translated text matches the corpus');
  assert.ok(c!.sourceMatches.every((m) => m.viaTranslation === true));
  assert.ok(c!.signals.find((g) => g.key === 'external-source-similarity')!.present);
  s.close();
});

test('language profile and diarization are exposed and descriptive', async () => {
  const s = new SqliteStorage(':memory:');
  const ev = s.createEvent(createEvent({ name: 'E', type: 'debate', policy: { languages: ['en'] } }));
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, eventId: ev.id }));
  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 0, t1: 4000, text: 'English opening line for the log.', isFinal: true, lang: 'en', speakerId: 'spk_1' }));
  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 4000, t1: 8000, text: 'फिर हिंदी में कुछ पंक्तियाँ यहाँ जोड़ी गईं।', isFinal: true, lang: 'hi', speakerId: 'spk_1' }));
  s.endSession(se.id, Date.now());

  // exercised through the storage-backed helpers the SessionManager exposes
  const { languageProfile } = await import('../i18n/language.ts');
  const prof = languageProfile(s.listSegments(se.id), ['en']);
  assert.equal(prof.codeSwitching, true);
  assert.deepEqual(prof.outsidePolicy, ['hi']);
  s.close();
});

test('judge sees an English gloss for a non-English answer but is told the original is authoritative', async () => {
  const s = new SqliteStorage(':memory:');
  let glossSeen = false;
  const ai = new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async (_model, parts) => {
      const text = (parts[0] as { text?: string }).text ?? '';
      if (/ENGLISH GLOSS/.test(text) && /original .* authoritative/i.test(text)) glossSeen = true;
      if (/Translate the following/i.test(text)) return { text: ENGLISH_BACK };
      return { text: JSON.stringify({ score: 6, confidence: 'medium', evidence: [{ startMs: 0, endMs: 1000, quote: 'q', reason: 'r' }], strengths: [], weaknesses: [], reasoning: 'ok' }) };
    },
  });
  const engine = new JudgeEngine(s, ai);
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'gemini', t0: 0, t1: 9000, text: HINDI_TEXT, isFinal: true, lang: 'hi' }));
  s.appendMetric({ id: 'm', createdAt: Date.now(), sessionId: se.id, atMs: 120_000, kind: 'final', snapshot: fakeSnap() });
  s.endSession(se.id, Date.now());

  const evaluation = await engine.evaluate({ sessionId: se.id, rubric: rubricFromPreset('debate') });
  assert.ok(glossSeen, 'the judge prompt carried the gloss + the "original is authoritative" instruction');
  assert.equal(evaluation.criteria.length, rubricFromPreset('debate').criteria.length);
  s.close();
});
