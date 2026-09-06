// Drill catalogue (spec §56) + the mapping from a Judge weakness to the drill
// that trains it. Deterministic — the drill PROMPT is generated per session, but
// which drill a weakness earns is a fixed, inspectable rule.

import type { DrillDifficulty, DrillType } from '../domain/types.ts';

export const DRILL_CATALOG: Record<
  Exclude<DrillType, 'retry'>,
  { label: string; goal: string; defaultTimeSec: number }
> = {
  'rebuttal-sprint': { label: 'Rebuttal Sprint', goal: 'answer an opposing claim within a few seconds: acknowledge → attack the assumption → counterpoint', defaultTimeSec: 40 },
  'evidence-challenge': { label: 'Evidence Challenge', goal: 'defend one claim using specific, relevant support', defaultTimeSec: 60 },
  'conciseness-drill': { label: 'Conciseness Drill', goal: 'make the argument in 20 seconds, one idea, no filler', defaultTimeSec: 25 },
  'signposting-drill': { label: 'Signposting Drill', goal: 'deliver a 45-second answer where the listener always knows which point is being made', defaultTimeSec: 50 },
  'pace-drill': { label: 'Pace Drill', goal: 'deliver at a controlled, steady pace with purposeful pauses', defaultTimeSec: 60 },
  'poi-gauntlet': { label: 'POI Gauntlet', goal: 'take rapid points of information and give short, direct responses without losing the thread', defaultTimeSec: 90 },
  'cross-examination': { label: 'Cross Examination', goal: 'hold up under increasingly pointed questions from an opponent', defaultTimeSec: 120 },
  'pressure-drill': { label: 'Pressure Drill', goal: 'stay composed and on-point while the opponent interrupts and introduces counters', defaultTimeSec: 120 },
  'interview-drill': { label: 'Interview Drill', goal: 'answer an adaptive interview question: direct answer first, then structured detail', defaultTimeSec: 90 },
};

const RULES: Array<{ match: RegExp; drill: Exclude<DrillType, 'retry'> }> = [
  { match: /rebuttal|refut|respond|engage|clash|counter/i, drill: 'rebuttal-sprint' },
  { match: /evidence|support|data|example|citation|substantiat|unsupported/i, drill: 'evidence-challenge' },
  { match: /conci|brev|too long|wordy|rambl|verbose|filler/i, drill: 'conciseness-drill' },
  { match: /signpost|structure|organis|organiz|roadmap|transition|order/i, drill: 'signposting-drill' },
  { match: /pace|speed|fast|slow|rushed|pause|hesitat/i, drill: 'pace-drill' },
  { match: /point of information|\bpoi\b|interrupt/i, drill: 'poi-gauntlet' },
  { match: /pressure|composure|confiden|nervous|shaken|flustered|latency/i, drill: 'pressure-drill' },
  { match: /cross[- ]?exam|being (questioned|probed)|under questioning|scrutin/i, drill: 'cross-examination' },
  { match: /interview|star|situation.*action.*result|relevance to the question/i, drill: 'interview-drill' },
];

/** Which drill trains this weakness. Falls back by event type. */
export function drillForWeakness(weaknessText: string, criterionName: string, eventType: string): Exclude<DrillType, 'retry'> {
  const hay = `${criterionName} ${weaknessText}`;
  for (const r of RULES) if (r.match.test(hay)) return r.drill;
  if (eventType === 'interview') return 'interview-drill';
  if (eventType === 'speech' || eventType === 'presentation') return 'signposting-drill';
  return 'rebuttal-sprint';
}

const ORDER: DrillDifficulty[] = ['beginner', 'intermediate', 'advanced', 'expert'];

/** Adaptive difficulty (spec §58) — met the target → step up; struggled → ease. */
export function nextDifficulty(current: DrillDifficulty, targetMet: boolean, marginRatio: number): DrillDifficulty {
  const i = ORDER.indexOf(current);
  if (targetMet && marginRatio >= 0.15) return ORDER[Math.min(ORDER.length - 1, i + 1)]!;
  if (!targetMet && marginRatio <= -0.2) return ORDER[Math.max(0, i - 1)]!;
  return current;
}

export function drillTimeSec(type: DrillType): number {
  return type === 'retry' ? 120 : DRILL_CATALOG[type].defaultTimeSec;
}
