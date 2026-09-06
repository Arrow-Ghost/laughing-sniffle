// Multi-judge consensus for a single session (spec §49).
//
// Combines every JudgeEvaluation recorded against one session into a per-criterion
// and overall agreement picture. It NEVER reads integrity — performance and
// integrity are separate concepts (spec §101). Disagreement is surfaced for a
// human ("divergentCriteria", "outlierJudges"), never silently averaged away.

import type { StorageProvider } from '../storage/StorageProvider.ts';
import type {
  CriterionConsensus,
  Id,
  JudgeEvaluation,
  SessionConsensus,
} from '../domain/types.ts';

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}
const round2 = (n: number): number => Math.round(n * 100) / 100;

/** Fraction of the scale beyond which we say judges "materially disagree". */
const DIVERGENCE_FRACTION = 0.2;

export function computeConsensus(storage: StorageProvider, sessionId: Id): SessionConsensus {
  const all = storage.listEvaluations(sessionId);
  // Consensus is about *finalised* judgements; fall back to everything if none are final yet.
  const finals = all.filter((e) => e.status === 'final');
  const evals: JudgeEvaluation[] = finals.length ? finals : all;

  const scaleMax = evals[0]?.scaleMax ?? 0;
  const first = evals[0] ?? null;

  const contributions = evals.map((e) => ({
    evaluationId: e.id,
    judgeType: e.judgeType,
    judgeId: e.judgeId,
    overallScore: round2(e.overallScore),
    status: e.status,
  }));

  const overalls = evals.map((e) => e.overallScore);
  const overallMean = round2(mean(overalls));
  const overallSpread = round2(overalls.length ? Math.max(...overalls) - Math.min(...overalls) : 0);
  const overallStddev = round2(stddev(overalls));

  // Per-criterion roll-up keyed by criterionId, preserving the first rubric's order.
  const criteria: CriterionConsensus[] = [];
  const seen = new Set<string>();
  for (const e of evals) {
    for (const c of e.criteria) {
      if (seen.has(c.criterionId)) continue;
      seen.add(c.criterionId);
      const perJudge: Array<{ evaluationId: Id; judgeId: string | null; score: number }> = [];
      for (const e2 of evals) {
        const match = e2.criteria.find((x) => x.criterionId === c.criterionId);
        if (match) perJudge.push({ evaluationId: e2.id, judgeId: e2.judgeId, score: match.score });
      }
      const scores = perJudge.map((p) => p.score);
      const spread = scores.length ? Math.max(...scores) - Math.min(...scores) : 0;
      criteria.push({
        criterionId: c.criterionId,
        criterionName: c.criterionName,
        weight: c.weight,
        mean: round2(mean(scores)),
        min: scores.length ? Math.min(...scores) : 0,
        max: scores.length ? Math.max(...scores) : 0,
        spread: round2(spread),
        stddev: round2(stddev(scores)),
        diverges: perJudge.length > 1 && spread > DIVERGENCE_FRACTION * (scaleMax || 1),
        perJudge,
      });
    }
  }

  const divergentCriteria = criteria.filter((c) => c.diverges).map((c) => c.criterionName);

  const outlierJudges = evals
    .map((e) => ({
      evaluationId: e.id,
      judgeId: e.judgeId,
      meanDeviation: round2(e.overallScore - overallMean),
    }))
    .filter((o) => evals.length > 1 && Math.abs(o.meanDeviation) > 0.1 * (scaleMax || 1))
    .sort((a, b) => Math.abs(b.meanDeviation) - Math.abs(a.meanDeviation));

  const agreement: SessionConsensus['agreement'] =
    evals.length < 2 || overallSpread <= 0.1 * (scaleMax || 1)
      ? 'strong'
      : overallSpread <= DIVERGENCE_FRACTION * (scaleMax || 1)
        ? 'moderate'
        : 'weak';

  const note =
    evals.length === 0
      ? 'No evaluations recorded for this session yet.'
      : evals.length === 1
        ? 'Single evaluation — no consensus to compute. Shown as-is.'
        : `${evals.length} evaluations (${evals.filter((e) => e.judgeType === 'human').length} human). ` +
          (divergentCriteria.length
            ? `Judges disagree on: ${divergentCriteria.join(', ')} — a human should reconcile these.`
            : 'Judges broadly agree across all criteria.');

  return {
    sessionId,
    rubricId: first?.rubricId ?? null,
    rubricName: first?.rubricName ?? null,
    scaleMax,
    judgeCount: evals.length,
    humanJudgeCount: evals.filter((e) => e.judgeType === 'human').length,
    contributions,
    overallMean,
    overallSpread,
    overallStddev,
    agreement,
    divergentCriteria,
    outlierJudges,
    criteria,
    note,
  };
}
