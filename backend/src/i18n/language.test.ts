import { test } from 'node:test';
import assert from 'node:assert/strict';
import { languageSpans, languageProfile } from './language.ts';
import { countHardFillers, fillerLexiconAvailable } from './fillers.ts';
import { createTranscriptSegment } from '../domain/entities.ts';
import type { TranscriptSegment } from '../domain/types.ts';

function seg(t0: number, t1: number, text: string, lang: string): TranscriptSegment {
  return createTranscriptSegment({ sessionId: 's1', source: 'gemini', t0, t1, text, isFinal: true, lang });
}

const CODE_SWITCH = [
  seg(0, 4000, 'Thank you chair, my first point is about trade.', 'en'),
  seg(4000, 9000, 'लेकिन असली सवाल यह है कि नीति से किसे फायदा होता है।', 'hi'),
  seg(9000, 13000, 'और यही मेरा मुख्य तर्क है।', 'hi'),
  seg(13000, 16000, 'So in conclusion, the policy fails working people.', 'en'),
];

test('languageSpans merges consecutive same-language segments', () => {
  const spans = languageSpans(CODE_SWITCH);
  assert.equal(spans.length, 3); // en, hi (merged), en
  assert.deepEqual(spans.map((s) => s.lang), ['en', 'hi', 'en']);
});

test('languageProfile reports shares, switches and code-switching', () => {
  const p = languageProfile(CODE_SWITCH);
  assert.equal(p.primary === 'en' || p.primary === 'hi', true);
  assert.equal(p.switches, 2);
  assert.equal(p.codeSwitching, true);
  const shares = Object.fromEntries(p.languages.map((l) => [l.lang, l.share]));
  assert.ok(shares.en! > 0 && shares.hi! > 0);
});

test('languageProfile flags languages outside the event policy — as a note, not a flag', () => {
  const p = languageProfile(CODE_SWITCH, ['en']); // only English permitted
  assert.deepEqual(p.outsidePolicy, ['hi']);
  // it is descriptive only — there is no "violation" field
  assert.ok(!('violation' in p) && !('penalty' in p));
});

test('a single-language transcript is not code-switching', () => {
  const p = languageProfile([seg(0, 5000, 'All in English here for the record.', 'en')]);
  assert.equal(p.codeSwitching, false);
  assert.equal(p.switches, 0);
  assert.equal(p.primary, 'en');
});

test('filler lexicon is chosen by language', () => {
  assert.equal(fillerLexiconAvailable('hi'), true);
  assert.equal(fillerLexiconAvailable('ja'), false);
  assert.ok(countHardFillers('matlab yaar toh haan', 'hi').count >= 3);
  assert.equal(countHardFillers('matlab yaar toh haan', 'en').count, 0);
});
