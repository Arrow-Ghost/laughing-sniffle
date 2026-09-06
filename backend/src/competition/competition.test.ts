import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SqliteStorage } from '../storage/SqliteStorage.ts';
import { createEvent, createParticipant, createSession } from '../domain/entities.ts';
import type { CriterionScore, JudgeEvaluation, JudgeType, Id } from '../domain/types.ts';
import { computeConsensus } from './consensus.ts';
import { tiebreak, type TieBreakStanding } from './tiebreak.ts';
import { buildLeaderboard } from './leaderboard.ts';
import { eventAnalytics } from './analytics.ts';

let seq = 0;
function crit(name: string, score: number, weight: number): CriterionScore {
  return {
    criterionId: `c-${name}`,
    criterionName: name,
    weight,
    score,
    aiScore: score,
    humanScore: null,
    confidence: 'medium',
    confidenceReasons: [],
    evidence: [],
    strengths: [],
    weaknesses: [],
    reasoning: 'x',
    overriddenBy: null,
    overrideReason: null,
  };
}

function addEval(
  s: SqliteStorage,
  sessionId: Id,
  opts: { judgeType?: JudgeType; judgeId?: string | null; status?: 'draft' | 'final'; overall: number; criteria: CriterionScore[] },
): JudgeEvaluation {
  const e: JudgeEvaluation = {
    id: `e-${++seq}`,
    createdAt: Date.now() + seq,
    sessionId,
    rubricId: 'r1',
    rubricName: 'Debate',
    judgeType: opts.judgeType ?? 'human',
    judgeId: opts.judgeId ?? `judge-${seq}`,
    status: opts.status ?? 'final',
    scaleMax: 10,
    overallScore: opts.overall,
    overallConfidence: 'medium',
    criteria: opts.criteria,
    notes: null,
  };
  return s.createEvaluation(e);
}

function fresh() {
  return new SqliteStorage(':memory:');
}

test('consensus: single evaluation is shown as-is with no divergence', () => {
  const s = fresh();
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  addEval(s, se.id, { overall: 7, criteria: [crit('Argumentation', 7, 0.5), crit('Delivery', 7, 0.5)] });
  const c = computeConsensus(s, se.id);
  assert.equal(c.judgeCount, 1);
  assert.equal(c.divergentCriteria.length, 0);
  assert.equal(c.agreement, 'strong');
  assert.match(c.note, /Single evaluation/);
  s.close();
});

test('consensus: flags a criterion where judges materially disagree', () => {
  const s = fresh();
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  addEval(s, se.id, { judgeId: 'A', overall: 8, criteria: [crit('Argumentation', 9, 0.5), crit('Delivery', 7, 0.5)] });
  addEval(s, se.id, { judgeId: 'B', overall: 5, criteria: [crit('Argumentation', 3, 0.5), crit('Delivery', 7, 0.5)] });
  const c = computeConsensus(s, se.id);
  assert.equal(c.judgeCount, 2);
  assert.deepEqual(c.divergentCriteria, ['Argumentation']);
  assert.equal(c.agreement, 'weak');
  assert.equal(c.overallMean, 6.5);
  assert.ok(c.outlierJudges.length >= 1);
  s.close();
});

test('consensus: never carries an integrity field', () => {
  const s = fresh();
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true } }));
  addEval(s, se.id, { overall: 6, criteria: [crit('Argumentation', 6, 1)] });
  const json = JSON.stringify(computeConsensus(s, se.id)).toLowerCase();
  for (const banned of ['risklevel', 'integrity', 'plagiar', 'probability', 'percent']) {
    assert.ok(!json.includes(banned), `consensus leaked "${banned}"`);
  }
  s.close();
});

test('tiebreak: overall score first, then criterion priority, recorded explainably', () => {
  const standings: TieBreakStanding[] = [
    { participantId: 'p1', participantLabel: 'Alice', overallScore: 8, criterionMeans: { Argumentation: 7 }, consensusSpread: 1, humanJudgeCount: 2 },
    { participantId: 'p2', participantLabel: 'Bob', overallScore: 8, criterionMeans: { Argumentation: 9 }, consensusSpread: 1, humanJudgeCount: 2 },
    { participantId: 'p3', participantLabel: 'Cara', overallScore: 6, criterionMeans: { Argumentation: 9 }, consensusSpread: 1, humanJudgeCount: 2 },
  ];
  const r = tiebreak(standings, { criterionPriority: ['Argumentation'] });
  assert.deepEqual(r.entries.map((e) => e.participantLabel), ['Bob', 'Alice', 'Cara']);
  assert.equal(r.entries[0]!.rank, 1);
  assert.equal(r.entries[1]!.rank, 2);
  assert.match(r.entries[1]!.brokenBy ?? '', /Argumentation/);
  assert.equal(r.entries[2]!.rank, 3);
});

test('tiebreak: an unbreakable tie shares a rank and is stated, not coin-flipped', () => {
  const standings: TieBreakStanding[] = [
    { participantId: 'p1', participantLabel: 'Alice', overallScore: 7, criterionMeans: {}, consensusSpread: 1, humanJudgeCount: 2 },
    { participantId: 'p2', participantLabel: 'Bob', overallScore: 7, criterionMeans: {}, consensusSpread: 1, humanJudgeCount: 2 },
  ];
  const r = tiebreak(standings, {});
  assert.equal(r.entries[0]!.rank, r.entries[1]!.rank);
  assert.ok(r.entries[1]!.tiedWithPrevious);
  assert.match(r.note, /could not be broken/);
});

test('leaderboard: public view exposes a status label only — never a risk level or signal', () => {
  const s = fresh();
  const ev = s.createEvent(createEvent({ name: 'Champs', type: 'debate' }));
  const p1 = s.createParticipant(createParticipant({ eventId: ev.id, displayName: 'Alice' }));
  const p2 = s.createParticipant(createParticipant({ eventId: ev.id, displayName: 'Bob' }));
  const s1 = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, eventId: ev.id, participantId: p1.id }));
  const s2 = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, eventId: ev.id, participantId: p2.id }));
  addEval(s, s1.id, { overall: 8.5, criteria: [crit('Argumentation', 8.5, 1)] });
  addEval(s, s2.id, { overall: 6, criteria: [crit('Argumentation', 6, 1)] });
  // An open integrity case on Bob.
  s.createIntegrityCase({
    id: 'ic1', createdAt: Date.now(), sessionId: s2.id, eventId: ev.id, participantId: p2.id,
    policySnapshot: s.getEvent(ev.id)!.policy, riskLevel: 'HIGH', confidence: 'medium',
    signals: [], sourceMatches: [], participantMatches: [], styleAnalysis: null,
    preparedness: { classification: 'uncertain', rehearsedScore: 0, indicators: [], note: '' },
    sessionIntegrity: { hashed: false, transcriptHash: null, anomalies: [], note: '' },
    recommendation: 'review', notProvedNote: 'n', searchCoverage: 'c', status: 'pending_review', review: null,
  });

  const pub = buildLeaderboard(s, ev.id, 'public');
  assert.deepEqual(pub.rows.map((r) => r.participantLabel), ['Alice', 'Bob']);
  assert.equal(pub.rows[0]!.integrityStatus, 'clear');
  assert.equal(pub.rows[1]!.integrityStatus, 'under-review');
  const pubJson = JSON.stringify(pub);
  for (const banned of ['HIGH', 'MODERATE', 'CRITICAL', 'riskLevel', 'signals', 'consensusSpread']) {
    assert.ok(!pubJson.includes(banned), `public leaderboard leaked "${banned}"`);
  }
  assert.equal(pub.rows[0]!.admin, undefined);

  const adm = buildLeaderboard(s, ev.id, 'admin');
  assert.equal(adm.rows[1]!.admin?.integrityRisk, 'HIGH');
  assert.ok(adm.rows[1]!.admin?.openCaseIds.includes('ic1'));
  s.close();
});

test('analytics: aggregates score distribution, judge leniency, and integrity counts only', () => {
  const s = fresh();
  const ev = s.createEvent(createEvent({ name: 'Champs', type: 'debate' }));
  const p1 = s.createParticipant(createParticipant({ eventId: ev.id, displayName: 'Alice' }));
  const se = s.createSession(createSession({ mode: 'debate-practice', consent: { speakerAcknowledged: true }, eventId: ev.id, participantId: p1.id }));
  addEval(s, se.id, { judgeId: 'lenient', overall: 9, criteria: [crit('Argumentation', 9, 1)] });
  addEval(s, se.id, { judgeId: 'harsh', overall: 5, criteria: [crit('Argumentation', 5, 1)] });
  const a = eventAnalytics(s, ev.id);
  assert.equal(a.participants, 1);
  assert.equal(a.evaluations, 2);
  assert.equal(a.finalEvaluations, 2);
  const lenient = a.judgeStats.find((j) => j.judgeId === 'lenient')!;
  const harsh = a.judgeStats.find((j) => j.judgeId === 'harsh')!;
  assert.ok(lenient.meanDeviationFromConsensus > 0, 'lenient judge scores above the room');
  assert.ok(harsh.meanDeviationFromConsensus < 0, 'harsh judge scores below the room');
  assert.equal(a.integritySummary.cases, 0);
  assert.equal(a.integritySummary.confirmedByHuman, 0);
  s.close();
});
