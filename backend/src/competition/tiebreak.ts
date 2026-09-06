// Deterministic tie-break engine (spec §51).
//
// Given a set of participant standings, produce a strict ranking. Every tie that
// gets broken records the exact rule that broke it, so the result is fully
// explainable to a participant. No randomness: if the rules run out, the entries
// stay tied and that is stated plainly (never a silent coin flip).

import type { Id, TieBreakEntry, TieBreakResult } from '../domain/types.ts';

export interface TieBreakStanding {
  participantId: Id;
  participantLabel: string;
  overallScore: number;
  /** Per-criterion means, keyed by criterion name — used by the criterion-priority rule. */
  criterionMeans: Record<string, number>;
  /** Lower = judges agreed more. Used by the "least disagreement" rule. */
  consensusSpread: number;
  /** Count of finalised human evaluations. Used by the "most human review" rule. */
  humanJudgeCount: number;
}

export interface TieBreakRules {
  /** Criterion names, highest priority first, compared when overall scores tie. */
  criterionPriority?: string[];
  /** Prefer the standing whose judges agreed more (lower spread). Default true. */
  preferLowerSpread?: boolean;
  /** Prefer the standing with more human judges behind it. Default true. */
  preferMoreHumanReview?: boolean;
}

const EPS = 1e-6;
const eq = (a: number, b: number): boolean => Math.abs(a - b) < EPS;

export function tiebreak(
  standings: TieBreakStanding[],
  rules: TieBreakRules = {},
  ctx: { eventId?: Id | null; roundId?: Id | null } = {},
): TieBreakResult {
  const criterionPriority = rules.criterionPriority ?? [];
  const preferLowerSpread = rules.preferLowerSpread !== false;
  const preferMoreHumanReview = rules.preferMoreHumanReview !== false;

  const rulesApplied: string[] = ['overall score'];
  if (criterionPriority.length) rulesApplied.push(`criterion priority: ${criterionPriority.join(' → ')}`);
  if (preferLowerSpread) rulesApplied.push('least judge disagreement');
  if (preferMoreHumanReview) rulesApplied.push('most human review');

  // Comparator returns <0 if a should rank ABOVE b. Also records why, on the winner.
  const why = new Map<Id, string>();
  const cmp = (a: TieBreakStanding, b: TieBreakStanding): number => {
    if (!eq(a.overallScore, b.overallScore)) return b.overallScore - a.overallScore;
    for (const name of criterionPriority) {
      const av = a.criterionMeans[name] ?? 0;
      const bv = b.criterionMeans[name] ?? 0;
      if (!eq(av, bv)) {
        const winner = av > bv ? a : b;
        why.set(winner.participantId, `higher "${name}" (${av > bv ? av : bv} vs ${av > bv ? bv : av})`);
        return bv - av;
      }
    }
    if (preferLowerSpread && !eq(a.consensusSpread, b.consensusSpread)) {
      const winner = a.consensusSpread < b.consensusSpread ? a : b;
      why.set(winner.participantId, `judges agreed more (spread ${winner.consensusSpread})`);
      return a.consensusSpread - b.consensusSpread;
    }
    if (preferMoreHumanReview && a.humanJudgeCount !== b.humanJudgeCount) {
      const winner = a.humanJudgeCount > b.humanJudgeCount ? a : b;
      why.set(winner.participantId, `more human review (${winner.humanJudgeCount} human judges)`);
      return b.humanJudgeCount - a.humanJudgeCount;
    }
    return 0;
  };

  const sorted = [...standings].sort(cmp);

  const entries: TieBreakEntry[] = sorted.map((s, i) => {
    const prev = i > 0 ? sorted[i - 1]! : null;
    const stillTied = prev != null && cmp(prev, s) === 0;
    const trace: string[] = [`overall score ${s.overallScore}`];
    let brokenBy: string | null = null;
    if (prev && eq(prev.overallScore, s.overallScore) && !stillTied) {
      brokenBy = why.get(prev.participantId) ?? why.get(s.participantId) ?? 'ordering rule';
      trace.push(`tied on overall with ${prev.participantLabel}; broken by: ${brokenBy}`);
    } else if (prev && !eq(prev.overallScore, s.overallScore)) {
      trace.push(`below ${prev.participantLabel} on overall score`);
    } else if (stillTied) {
      trace.push(`still tied with ${prev!.participantLabel} after all rules — ranked equal, manual decision required`);
    }
    return {
      participantId: s.participantId,
      participantLabel: s.participantLabel,
      rank: i + 1,
      overallScore: s.overallScore,
      tiedWithPrevious: stillTied,
      brokenBy,
      trace,
    };
  });

  // Equal ranks for entries the rules could not separate.
  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.tiedWithPrevious) entries[i]!.rank = entries[i - 1]!.rank;
  }

  const unresolved = entries.filter((e) => e.tiedWithPrevious).length;
  const note = unresolved
    ? `${unresolved} tie(s) could not be broken by the configured rules — those entries share a rank and need a manual decision.`
    : 'All ties resolved deterministically.';

  return {
    eventId: ctx.eventId ?? null,
    roundId: ctx.roundId ?? null,
    rulesApplied,
    entries,
    note,
  };
}
