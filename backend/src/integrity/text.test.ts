import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyQuotation,
  containment,
  distinctivePhrases,
  isAttributed,
  isCommonPhrase,
  jaccard,
  phraseUniqueness,
  sentences,
  shingles,
} from './text.ts';

test('sentences splits on terminal punctuation, drops sub-3-word fragments', () => {
  const s = sentences('Thank you chair today. My first point is about trade tariffs. This really matters here.');
  assert.equal(s.length, 3);
  assert.equal(sentences('Thank you chair. My first point is about trade. It matters!').length, 2);
});

test('shingles + containment + jaccard', () => {
  const a = shingles('the quick brown fox jumps', 3);
  const b = shingles('a quick brown fox jumps over', 3);
  assert.ok(containment(a, b) > 0.5);
  assert.ok(jaccard(a, b) > 0.3 && jaccard(a, b) < 1);
  assert.equal(containment(shingles('totally unrelated words here now', 3), a), 0);
});

test('isCommonPhrase catches generic openers and function-word soup', () => {
  assert.ok(isCommonPhrase('So, today I would like to talk about trade policy.'));
  assert.ok(isCommonPhrase('The core issue here is whether it works.'));
  assert.ok(isCommonPhrase('and it is and it was and they were and we are'));
  assert.ok(!isCommonPhrase('Carbon markets collapse when regulatory credibility erodes under political pressure.'));
});

test('phraseUniqueness: distinctive technical phrasing scores high, boilerplate low', () => {
  assert.ok(phraseUniqueness('Carbon markets collapse when regulatory credibility erodes under sustained political pressure') > 0.5);
  assert.ok(phraseUniqueness('I think that we should do the thing now') < 0.4);
});

test('distinctivePhrases returns the high-information sentences, ranked', () => {
  const text =
    'Thank you chair. So today I want to discuss trade. ' +
    'When economies open to trade without adjustment assistance for displaced workers, the losses are concentrated in specific communities. ' +
    'It matters a lot.';
  const d = distinctivePhrases(text, { minUniqueness: 0.4 });
  assert.ok(d.length >= 1);
  assert.match(d[0]!.text, /adjustment assistance for displaced workers/);
});

test('isAttributed detects "according to" and direct quotes', () => {
  assert.ok(isAttributed('According to the IMF, trade openness concentrates losses in specific communities.', 'trade openness concentrates losses'));
  assert.ok(!isAttributed('Trade openness concentrates losses in specific communities and that is bad.', 'trade openness concentrates losses'));
});

test('classifyQuotation maps similarity + attribution', () => {
  assert.equal(classifyQuotation(0.9, false, 0.7), 'copied');
  assert.equal(classifyQuotation(0.9, true, 0.7), 'quoted');
  assert.equal(classifyQuotation(0.5, false, 0.7), 'paraphrased');
  assert.equal(classifyQuotation(0.9, false, 0.2), 'common-knowledge');
  assert.equal(classifyQuotation(0.05, false, 0.7), 'original');
});
