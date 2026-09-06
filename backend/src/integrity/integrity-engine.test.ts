import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../storage/SqliteStorage.ts';
import { IntegrityEngine } from './index.ts';
import { MockSourceSearchProvider } from './source-search/MockSourceSearchProvider.ts';
import { createEvent, createSession, createTranscriptSegment } from '../domain/entities.ts';
import type { EventPolicy } from '../domain/types.ts';

function fresh() {
  const s = new SqliteStorage(':memory:');
  return { s, engine: new IntegrityEngine(s, new MockSourceSearchProvider()) };
}

function seed(
  s: SqliteStorage,
  transcripts: Record<string, string>,
  policy?: Partial<EventPolicy>,
): { eventId: string; ids: Record<string, string> } {
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

/** Recursively collect every object key present in a value. */
function allKeys(v: unknown, acc = new Set<string>()): Set<string> {
  if (Array.isArray(v)) v.forEach((x) => allKeys(x, acc));
  else if (v && typeof v === 'object') {
    for (const [k, val] of Object.entries(v)) {
      acc.add(k);
      allKeys(val, acc);
    }
  }
  return acc;
}

const DISTINCTIVE_NO_ATTRIB =
  'Carbon markets collapse when regulatory credibility erodes under political pressure. ' +
  'When economies open to trade without adjustment assistance for displaced workers, the losses are concentrated in specific communities.';

/* ------------------------- spec §105 false-positive suite ------------------------- */

test('Case A — two participants share only a common opener → LOW, no cross-participant signal', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, {
    x: 'So today I would like to talk about trade policy. My own reading is that tariffs seldom achieve their stated aims for the median household.',
    y: 'So today I would like to talk about trade policy. In my experience the debate usually skips over exchange-rate effects entirely.',
  });
  const { case: c } = await engine.analyzeSession(ids.x!);
  assert.equal(c!.riskLevel, 'LOW');
  assert.equal(c!.signals.find((g) => g.key === 'cross-participant-similarity')!.present, false);
  s.close();
});

test('Case B — a source quote WITH attribution → low concern, external-source signal absent', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, {
    x: 'According to the OECD, programmes that pair open markets with serious adjustment assistance show materially better outcomes for affected workers than trade liberalisation alone. I find that framing persuasive.',
  });
  const { case: c } = await engine.analyzeSession(ids.x!);
  assert.ok(c!.sourceMatches.length >= 1, 'the source is still located');
  assert.ok(['quoted', 'attributed'].includes(c!.sourceMatches[0]!.quotationClass));
  assert.equal(c!.signals.find((g) => g.key === 'external-source-similarity')!.present, false);
  assert.notEqual(c!.riskLevel, 'HIGH');
  s.close();
});

test('Case C — distinctive source wording WITHOUT attribution → source-similarity signal fires', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, { x: DISTINCTIVE_NO_ATTRIB });
  const { case: c } = await engine.analyzeSession(ids.x!);
  const sig = c!.signals.find((g) => g.key === 'external-source-similarity')!;
  assert.equal(sig.present, true);
  assert.ok(sig.strength >= 0.5, `strength ${sig.strength}`);
  assert.ok(c!.sourceMatches.length >= 1);
  // one origin (source-search), however many facets → capped at MODERATE (spec §39)
  assert.equal(c!.riskLevel, 'MODERATE');
  s.close();
});

test('Case D — a more polished passage (style only) is not a Phase 3 signal → LOW', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, {
    x: 'My argument tonight rests on three observations about how my hometown responded to the mill closures in the late nineteen nineties, none of which appear in any briefing.',
  });
  const { case: c } = await engine.analyzeSession(ids.x!);
  assert.equal(c!.riskLevel, 'LOW');
  assert.ok(c!.signals.every((g) => !g.present));
  s.close();
});

test('Case E — distinctive match + cross-participant + prohibited internet → HIGH', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(
    s,
    {
      x: DISTINCTIVE_NO_ATTRIB,
      y: 'Opening remarks aside. ' + DISTINCTIVE_NO_ATTRIB + ' And that is my whole case.',
    },
    { internet: 'prohibited', externalSources: 'prohibited' },
  );
  const { case: c } = await engine.analyzeSession(ids.x!);
  const origins = new Set(c!.signals.filter((g) => g.present).map((g) => g.origin));
  assert.ok(origins.has('source-search') && origins.has('cross-participant'), [...origins].join(','));
  assert.equal(c!.riskLevel, 'HIGH');
  s.close();
});

test('Case F — prepared original speech, no matches → LOW and no AI accusation anywhere', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, {
    x: 'I prepared this carefully over the past month. The through-line of my case is that dignity in work is not reducible to a wage figure, drawn from conversations in my own community.',
  });
  const { case: c } = await engine.analyzeSession(ids.x!);
  assert.equal(c!.riskLevel, 'LOW');
  // scan the parts that face a reviewer as findings — not the fixed disclaimers,
  // which legitimately say "AI use cannot be established".
  const findings = JSON.stringify({
    riskLevel: c!.riskLevel,
    recommendation: c!.recommendation,
    signals: c!.signals,
    sourceMatches: c!.sourceMatches,
    participantMatches: c!.participantMatches,
  }).toLowerCase();
  for (const banned of ['chatgpt', 'used ai', 'ai-generated', 'plagiar', 'cheat', 'guilty', 'definitely', 'probability']) {
    assert.ok(!findings.includes(banned), `findings leaked "${banned}"`);
  }
  s.close();
});

/* ----------------------------- structural guards ----------------------------- */

test('an IntegrityCase never carries a probability / percentage / internal score (spec §3)', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, { x: DISTINCTIVE_NO_ATTRIB });
  const { case: c } = await engine.analyzeSession(ids.x!);
  const keys = allKeys(c);
  for (const forbidden of ['probability', 'percent', 'internalScore', 'aiLikelihood', 'likelihood', 'score', 'overallScore', 'criteria', 'rubricId']) {
    assert.ok(!keys.has(forbidden), `case object has a "${forbidden}" key`);
  }
  // No percentage presented as an AI/usage/probability certainty (spec §3).
  // (A word-overlap "%" in an evidence string is a factual similarity measure and is fine.)
  assert.doesNotMatch(
    JSON.stringify(c),
    /\d{1,3}\s?%\s*(ai|chatgpt|usage|probabilit|likelihood|certain|confiden|cheat)/i,
  );
  assert.doesNotMatch(JSON.stringify(c), /(ai|chatgpt|usage|probability)\s*[:=]?\s*\d{1,3}\s?%/i);
  s.close();
});

test('only review() can set "confirmed", and it requires a reviewerId (spec §42)', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, { x: DISTINCTIVE_NO_ATTRIB });
  const { case: c } = await engine.analyzeSession(ids.x!);
  assert.equal(c!.status, 'pending_review');

  assert.throws(() => engine.review({ caseId: c!.id, reviewerId: '', decision: 'confirm', reason: 'x' }), /reviewerId is required/);
  assert.throws(() => engine.review({ caseId: c!.id, reviewerId: 'r1', decision: 'confirm' }), /requires a reason/);

  const reviewed = engine.review({ caseId: c!.id, reviewerId: 'chief-adjudicator', decision: 'confirm', reason: 'verbatim, unattributed, and the source was on the banned list' });
  assert.equal(reviewed.status, 'confirmed');
  assert.equal(reviewed.review!.reviewerId, 'chief-adjudicator');

  const actions = s.listAuditBySession(ids.x!).map((a) => a.action);
  assert.ok(actions.includes('integrity.case.created'));
  assert.ok(actions.includes('integrity.case.reviewed'));
  s.close();
});

test('policy allows AI → analytics row, NO case (spec §97)', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, { x: DISTINCTIVE_NO_ATTRIB }, { aiAssistance: 'allowed' });
  const { case: c, analytics } = await engine.analyzeSession(ids.x!);
  assert.equal(c, null);
  assert.ok(analytics);
  assert.ok(analytics!.sourceMatchCount >= 1);
  assert.equal(s.listIntegrityCasesBySession(ids.x!).length, 0);
  assert.equal(s.listIntegrityAnalyticsBySession(ids.x!).length, 1);
  s.close();
});

test('review decisions map to the right status and are audited', async () => {
  const { s, engine } = fresh();
  const { ids } = seed(s, { x: DISTINCTIVE_NO_ATTRIB });
  const { case: c } = await engine.analyzeSession(ids.x!);
  const r = engine.review({ caseId: c!.id, reviewerId: 'r1', decision: 'dismiss', reason: 'common knowledge in this format' });
  assert.equal(r.status, 'dismissed');
  assert.equal(s.getIntegrityCase(c!.id)!.status, 'dismissed');
  s.close();
});

test('a standalone session (no event) still analyses, cross-participant simply empty', async () => {
  const { s, engine } = fresh();
  const se = s.createSession(createSession({ mode: 'speech-coaching', consent: { speakerAcknowledged: true } }));
  s.appendSegment(createTranscriptSegment({ sessionId: se.id, source: 'browser', t0: 0, t1: 5000, text: DISTINCTIVE_NO_ATTRIB, isFinal: true }));
  const { case: c } = await engine.analyzeSession(se.id);
  assert.equal(c!.participantMatches.length, 0);
  assert.ok(c!.signals.find((g) => g.key === 'external-source-similarity')!.present);
  s.close();
});
