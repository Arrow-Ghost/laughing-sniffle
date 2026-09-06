import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../storage/SqliteStorage.ts';
import { AIGateway } from '../ai/AIGateway.ts';
import { CoachEngine } from './index.ts';
import { createParticipant, createSession, createTranscriptSegment } from '../domain/entities.ts';
import type { JudgeEvaluation, SpeechMetric } from '../domain/types.ts';
import type { SpeechSnapshot } from '../speech-core/index.ts';

const MODELS = { transcribe: ['t'], coach: ['c'], judge: ['j'], similarity: ['s'], summarize: ['sm'] };

/** One mock that answers every coach AI call by branching on the prompt text. */
function mockAi() {
  return new AIGateway({
    apiKey: '',
    models: MODELS,
    _call: async (_m, parts) => {
      const text = (parts[0] as { text?: string }).text ?? '';
      if (/"summary": string, "keepDoing"/.test(text)) {
        const voice = /Voice: ([^\n]+)/.exec(text)?.[1] ?? '';
        return { text: JSON.stringify({ summary: `[${voice.slice(0, 12)}] focus on the flagged gaps.`, keepDoing: ['clear thesis'] }) };
      }
      if (/"score": <integer/.test(text)) return { text: JSON.stringify({ score: 8, targetMet: true, feedback: 'Much tighter — you hit the counter within three seconds.' }) };
      if (/Write the prompt for a/.test(text)) return { text: 'Opposing claim: tariffs protect jobs. You have 40 seconds — acknowledge, attack the assumption, give a counterpoint.' };
      if (/opposing debater/.test(text)) return { text: 'But your counter assumes retraining works — take-up is under 20%. Address that.' };
      return { text: '{}' };
    },
  });
}

function seedEvaluation(s: SqliteStorage, sessionId: string, weaknessesByCriterion: Record<string, string[]>, scores: Record<string, number> = {}): JudgeEvaluation {
  const criteria = Object.entries(weaknessesByCriterion).map(([criterionName, weaknesses], i) => ({
    criterionId: `c${i}`,
    criterionName,
    weight: 1 / Object.keys(weaknessesByCriterion).length,
    score: scores[criterionName] ?? 5,
    aiScore: scores[criterionName] ?? 5,
    humanScore: null,
    confidence: 'medium' as const,
    confidenceReasons: [],
    evidence: [{ startMs: 1000, endMs: 3000, quote: 'a quoted moment', reason: 'r' }],
    strengths: i === 0 ? ['strong opening'] : [],
    weaknesses,
    reasoning: 'ok',
    overriddenBy: null,
    overrideReason: null,
  }));
  const ev: JudgeEvaluation = {
    id: `ev-${sessionId}`,
    createdAt: Date.now(),
    sessionId,
    rubricId: 'r1',
    rubricName: 'Debate — standard',
    judgeType: 'ai',
    judgeId: null,
    status: 'final',
    scaleMax: 10,
    overallScore: 5,
    overallConfidence: 'medium',
    criteria,
    notes: null,
  };
  s.createEvaluation(ev);
  return ev;
}

function fakeSnap(o: Partial<{ wpm: number; filler: number; pauses: number; variety: number; talk: number }> = {}): SpeechSnapshot {
  const x = { wpm: 150, filler: 3, pauses: 8, variety: 0.85, talk: 0.75, ...o };
  return {
    elapsedMs: 120_000,
    transcript: { text: 'x '.repeat(120), wordCount: 120, source: 'gemini' },
    pace: { wpm: x.wpm, descriptor: 'steady', window: '', ready: true },
    pauses: { count: x.pauses, meanMs: 800, longestMs: 1500 },
    fillers: { ready: true, hardPerMin: x.filler, softPerMin: 0, hardExamples: [], softExamples: [], note: '' },
    vocabulary: { variety: x.variety, varietyBasis: 'MATTR-50', longWordRate: 0.18, distinctWords: 90, meanUnitLength: 14, meanUnitBasis: 'punctuation' },
    delivery: { talkRatio: x.talk, speakingSecondsTotal: 100 },
    answerLatency: { pending: false, latencyMs: 900 },
    timeline: [],
  };
}
function putSnap(s: SqliteStorage, sessionId: string, snap: SpeechSnapshot) {
  const m: SpeechMetric = { id: `${sessionId}-m`, createdAt: Date.now(), sessionId, atMs: 120_000, kind: 'final', snapshot: snap };
  s.appendMetric(m);
}

test('plan: weaknesses are copied VERBATIM from the Judge Engine (spec §89)', async () => {
  const s = new SqliteStorage(':memory:');
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  const ev = seedEvaluation(s, se.id, {
    Rebuttal: ['You did not engage the opponent’s strongest claim about currency effects.'],
    Evidence: ['The third argument had no supporting evidence at all.'],
  });
  const allWeaknessStrings = ev.criteria.flatMap((c) => c.weaknesses);

  const plan = await new CoachEngine(s, mockAi()).plan({ sessionId: se.id });
  assert.equal(plan.weaknesses.length, 2);
  for (const w of plan.weaknesses) {
    assert.ok(allWeaknessStrings.includes(w.weaknessText), `not verbatim: "${w.weaknessText}"`);
    assert.ok(w.suggestedDrill);
    assert.ok(w.evidence.length >= 1);
  }
  assert.deepEqual(plan.focusAreas.slice(0, 2).sort(), ['Evidence', 'Rebuttal']);
  s.close();
});

test('plan: persona changes the summary wording only, not the weaknesses or focus', async () => {
  const s = new SqliteStorage(':memory:');
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  seedEvaluation(s, se.id, { Rebuttal: ['weak clash'], Delivery: ['rushed the close'] });
  const engine = new CoachEngine(s, mockAi());

  const a = await engine.plan({ sessionId: se.id, persona: 'supportive' });
  const b = await engine.plan({ sessionId: se.id, persona: 'strict' });
  assert.deepEqual(a.weaknesses.map((w) => w.weaknessText), b.weaknesses.map((w) => w.weaknessText));
  assert.deepEqual(a.focusAreas, b.focusAreas);
  assert.notEqual(a.summary, b.summary);
  s.close();
});

test('plan: no evaluation → 422', async () => {
  const s = new SqliteStorage(':memory:');
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  await assert.rejects(() => new CoachEngine(s, mockAi()).plan({ sessionId: se.id }), /judge evaluation first/);
  s.close();
});

test('plan: an all-strong evaluation yields no weaknesses and keepDoing', async () => {
  const s = new SqliteStorage(':memory:');
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  seedEvaluation(s, se.id, { Rebuttal: [], Evidence: [] }, { Rebuttal: 9, Evidence: 8 });
  const plan = await new CoachEngine(s, mockAi()).plan({ sessionId: se.id });
  assert.equal(plan.weaknesses.length, 0);
  assert.ok(plan.keepDoing.length >= 1);
  s.close();
});

test('startDrill → attach response → grade → adaptive difficulty + audit', async () => {
  const s = new SqliteStorage(':memory:');
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  seedEvaluation(s, se.id, { Rebuttal: ['did not engage the opponent directly'] });
  const engine = new CoachEngine(s, mockAi());
  const plan = await engine.plan({ sessionId: se.id });

  const drill = await engine.startDrill({ planId: plan.id });
  assert.equal(drill.type, 'rebuttal-sprint');
  assert.equal(drill.status, 'ready');
  assert.match(drill.prompt, /acknowledge/i);

  const resp = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  s.appendSegment(createTranscriptSegment({ sessionId: resp.id, source: 'gemini', t0: 0, t1: 8000, text: 'Acknowledged — but the assumption that retraining works is false, take-up is under twenty percent.', isFinal: true }));
  putSnap(s, resp.id, fakeSnap({ filler: 1, wpm: 165 }));
  s.endSession(resp.id, Date.now());
  engine.attachResponse({ drillId: drill.id, responseSessionId: resp.id });

  const graded = await engine.gradeDrill({ drillId: drill.id });
  assert.equal(graded.status, 'complete');
  assert.equal(graded.grade!.score, 8);
  assert.equal(graded.grade!.targetMet, true);
  assert.equal(graded.grade!.suggestedNextDifficulty, 'advanced'); // met with margin → step up

  const actions = s.listAuditBySession(se.id).map((a) => a.action);
  assert.ok(actions.includes('coach.plan.created') && actions.includes('coach.drill.started') && actions.includes('coach.drill.graded'));
  s.close();
});

test('AI opponent keeps session memory across turns (spec §57)', async () => {
  const s = new SqliteStorage(':memory:');
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  seedEvaluation(s, se.id, { Rebuttal: ['weak clash'] });
  const engine = new CoachEngine(s, mockAi());
  const plan = await engine.plan({ sessionId: se.id });
  const drill = await engine.startDrill({ planId: plan.id });

  await engine.opponentTurn({ drillId: drill.id, lastArgument: 'Tariffs cost consumers more than they protect.' });
  const after = await engine.opponentTurn({ drillId: drill.id, lastArgument: 'And the jobs saved are fewer than the jobs lost downstream.' });
  assert.equal(after.exchanges.length, 4);
  assert.deepEqual(after.exchanges.map((e) => e.role), ['participant', 'opponent', 'participant', 'opponent']);
  s.close();
});

test('compare: before/after per-criterion + per-metric deltas, no invented numbers', async () => {
  const s = new SqliteStorage(':memory:');
  const before = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  const after = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  seedEvaluation(s, before.id, { Rebuttal: ['weak'] }, { Rebuttal: 5 });
  seedEvaluation(s, after.id, { Rebuttal: [] }, { Rebuttal: 8 });
  putSnap(s, before.id, fakeSnap({ filler: 5 }));
  putSnap(s, after.id, fakeSnap({ filler: 1.5 }));

  const cmp = new CoachEngine(s, mockAi()).compare({ beforeSessionId: before.id, afterSessionId: after.id });
  const reb = cmp.criteria.find((c) => c.criterionName === 'Rebuttal')!;
  assert.equal(reb.before, 5);
  assert.equal(reb.after, 8);
  assert.equal(reb.delta, 3);
  const filler = cmp.metrics.find((m) => m.metric === 'hard fillers /min')!;
  assert.equal(filler.delta, -3.5);
  s.close();
});

test('progress uses only the participant’s own ended sessions, ordered, with a trend', () => {
  const s = new SqliteStorage(':memory:');
  const p = s.createParticipant(createParticipant({ displayName: 'P1' })).id;
  for (const [i, wpm] of [140, 150, 165].entries()) {
    const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, participantId: p }));
    seedEvaluation(s, se.id, { Rebuttal: [] }, { Rebuttal: 5 + i });
    // patch overall so trend is visible
    const ev = s.getEvaluation(`ev-${se.id}`)!;
    ev.overallScore = 5 + i;
    s.updateEvaluation(ev);
    putSnap(s, se.id, fakeSnap({ wpm }));
    s.endSession(se.id, Date.now() + i * 1000);
  }
  // a different participant's session must be excluded
  const p2 = s.createParticipant(createParticipant({ displayName: 'P2' })).id;
  const other = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, participantId: p2 }));
  s.endSession(other.id, Date.now());

  const prog = new CoachEngine(s, {} as never).progress(p);
  assert.equal(prog.series.length, 3);
  assert.deepEqual(prog.series.map((x) => x.wpm), [140, 150, 165]);
  assert.equal(prog.trend.wpm, 25);
  assert.equal(prog.trend.overallScore, 2);
  s.close();
});

test('a coach plan carries no integrity / risk fields', async () => {
  const s = new SqliteStorage(':memory:');
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  seedEvaluation(s, se.id, { Rebuttal: ['weak clash'] });
  const plan = await new CoachEngine(s, mockAi()).plan({ sessionId: se.id });
  const jsonl = JSON.stringify(plan).toLowerCase();
  for (const banned of ['risklevel', 'integrity', 'probability', 'plagiar', 'cheat', 'suspicion']) {
    assert.ok(!jsonl.includes(banned), `plan leaked "${banned}"`);
  }
  s.close();
});
