import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockSourceSearchProvider, SEED_CORPUS } from './source-search/MockSourceSearchProvider.ts';
import { classifyDomain, CREDIBILITY } from './source-search/SourceSearchProvider.ts';

test('classifyDomain buckets domains, credibility ranks them', () => {
  assert.equal(classifyDomain('stanford.edu'), 'academic');
  assert.equal(classifyDomain('oecd.org'), 'government');
  assert.equal(classifyDomain('reuters.com'), 'news');
  assert.equal(classifyDomain('en.wikipedia.org'), 'reference');
  assert.equal(classifyDomain('someblog.substack.com'), 'blog');
  assert.equal(classifyDomain('reddit.com'), 'forum');
  assert.equal(classifyDomain('acme-corp.com'), 'corporate');
  assert.ok(CREDIBILITY.academic > CREDIBILITY.news);
  assert.ok(CREDIBILITY.news > CREDIBILITY.blog);
  assert.ok(CREDIBILITY.blog > CREDIBILITY.social);
});

test('mock provider returns overlapping seeded docs, ranked; nothing for unrelated text', async () => {
  const p = new MockSourceSearchProvider();
  const hits = await p.search(
    'carbon markets collapse when regulatory credibility erodes under political pressure',
  );
  assert.ok(hits.length >= 1);
  assert.ok(hits.some((h) => /substack|imf/.test(h.domain)));
  assert.ok(hits[0]!.snippet.length > 0);

  const none = await p.search('my favourite recipe for lemon drizzle cake with three eggs');
  assert.equal(none.length, 0);
});

test('coverageNote is honest about what was searched (spec §86)', () => {
  const p = new MockSourceSearchProvider();
  assert.match(p.coverageNote, /not a live web search/i);
  assert.doesNotMatch(p.coverageNote, /entire internet|everything/i);
});

test('provider is seedable for a demo corpus', async () => {
  const p = new MockSourceSearchProvider([
    { url: 'https://x.test/a', domain: 'x.test', title: 'A', sourceType: 'unknown', text: 'the mitochondria is the powerhouse of the cell and produces atp' },
  ]);
  const hits = await p.search('mitochondria is the powerhouse of the cell');
  assert.equal(hits.length, 1);
  assert.equal(hits[0]!.domain, 'x.test');
  assert.ok(SEED_CORPUS.length === 6);
});
