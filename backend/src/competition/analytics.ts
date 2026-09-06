// Post-event analytics (spec §63).
//
// Descriptive aggregates only. Judge stats surface leniency/harshness relative to
// the room's consensus — an instrument for calibration, not a judgement of the
// judge. The integrity summary is COUNTS by risk and status; it never lists which
// participant, and "confirmed" is only ever the count of human-confirmed cases.

import type { StorageProvider } from '../storage/StorageProvider.ts';
import type {
  EventAnalytics,
  Id,
  IntegrityCaseStatus,
  JudgeType,
  RiskLevel,
} from '../domain/types.ts';
import { computeConsensus } from './consensus.ts';

const round2 = (n: number): number => Math.round(n * 100) / 100;

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : round2((s[mid - 1]! + s[mid]!) / 2);
}
function mean(xs: number[]): number | null {
  return xs.length ? round2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
}
function stddev(xs: number[]): number | null {
  if (xs.length < 2) return 0;
  const m = xs.reduce((a, b) => a + b, 0) / xs.length;
  return round2(Math.sqrt(xs.map((x) => (x - m) ** 2).reduce((a, b) => a + b, 0) / xs.length));
}

export function eventAnalytics(storage: StorageProvider, eventId: Id): EventAnalytics {
  const event = storage.getEvent(eventId);
  if (!event) throw new Error('event not found');

  const participants = storage.listParticipantsByEvent(eventId);
  const sessions = storage.listSessions({ eventId });
  const allEvals = sessions.flatMap((s) => storage.listEvaluations(s.id));
  const finals = allEvals.filter((e) => e.status === 'final');
  const scaleMax = allEvals[0]?.scaleMax ?? 0;

  // One consensus overall per session, for the score distribution.
  const perSessionOverall: number[] = sessions
    .map((s) => computeConsensus(storage, s.id))
    .filter((c) => c.judgeCount > 0)
    .map((c) => c.overallMean);

  const histBuckets = scaleMax > 0 ? 5 : 0;
  const histogram: Array<{ bucket: string; count: number }> = [];
  for (let i = 0; i < histBuckets; i++) {
    const lo = round2((i / histBuckets) * scaleMax);
    const hi = round2(((i + 1) / histBuckets) * scaleMax);
    const count = perSessionOverall.filter((v) => v >= lo && (i === histBuckets - 1 ? v <= hi : v < hi)).length;
    histogram.push({ bucket: `${lo}-${hi}`, count });
  }

  // Criterion averages across finalised evaluations.
  const critMap = new Map<string, number[]>();
  for (const e of finals) {
    for (const c of e.criteria) {
      const arr = critMap.get(c.criterionName) ?? [];
      arr.push(c.score);
      critMap.set(c.criterionName, arr);
    }
  }
  const criterionAverages = [...critMap.entries()].map(([criterionName, xs]) => ({
    criterionName,
    mean: mean(xs) ?? 0,
    n: xs.length,
  }));

  // Judge stats: for each judge, mean score given and mean deviation from the
  // per-session consensus of the OTHER judges' overalls.
  const judgeAgg = new Map<string, { type: JudgeType; given: number[]; dev: number[] }>();
  for (const s of sessions) {
    const evs = storage.listEvaluations(s.id);
    if (evs.length < 1) continue;
    const overalls = evs.map((e) => e.overallScore);
    for (const e of evs) {
      const others = overalls.filter((_, i) => evs[i]!.id !== e.id);
      const roomMean = others.length ? others.reduce((a, b) => a + b, 0) / others.length : e.overallScore;
      const key = e.judgeId ?? (e.judgeType === 'ai' ? 'ai-judge' : 'unnamed-human');
      const agg = judgeAgg.get(key) ?? { type: e.judgeType, given: [], dev: [] };
      agg.given.push(e.overallScore);
      agg.dev.push(e.overallScore - roomMean);
      judgeAgg.set(key, agg);
    }
  }
  const judgeStats = [...judgeAgg.entries()].map(([judgeId, a]) => ({
    judgeId,
    judgeType: a.type,
    evaluations: a.given.length,
    meanScoreGiven: mean(a.given) ?? 0,
    meanDeviationFromConsensus: mean(a.dev) ?? 0,
  }));

  // Integrity: counts only.
  const cases = storage.listIntegrityCasesByEvent(eventId);
  const byRisk: Record<RiskLevel, number> = { LOW: 0, MODERATE: 0, HIGH: 0, CRITICAL: 0 };
  const byStatus: Record<IntegrityCaseStatus, number> = {
    pending_review: 0,
    dismissed: 0,
    monitoring: 0,
    investigating: 0,
    confirmed: 0,
  };
  for (const c of cases) {
    byRisk[c.riskLevel]++;
    byStatus[c.status]++;
  }

  // Coaching uptake.
  const plans = sessions.flatMap((s) => storage.listCoachPlansBySession(s.id));
  const drills = plans.flatMap((p) => storage.listDrillsByPlan(p.id));
  const participantsWithPlan = new Set(plans.map((p) => p.participantId).filter(Boolean)).size;

  return {
    eventId,
    eventName: event.name,
    generatedAt: Date.now(),
    participants: participants.length,
    sessions: sessions.length,
    sessionsEnded: sessions.filter((s) => s.status === 'ended').length,
    evaluations: allEvals.length,
    finalEvaluations: finals.length,
    scoreDistribution: {
      scaleMax,
      count: perSessionOverall.length,
      mean: mean(perSessionOverall),
      median: median(perSessionOverall),
      stddev: stddev(perSessionOverall),
      histogram,
    },
    criterionAverages,
    judgeStats,
    integritySummary: {
      cases: cases.length,
      byRisk,
      byStatus,
      confirmedByHuman: byStatus.confirmed,
      note: 'Counts only. A case is a prompt for human review; "confirmed" means a named reviewer confirmed it, not that the system decided.',
    },
    coaching: { plans: plans.length, drills: drills.length, participantsWithPlan },
  };
}
