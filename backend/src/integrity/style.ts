// Per-speaker style baseline (spec §37). Built from a participant's OWN prior
// sessions and used only to describe how the current answer differs from their
// norm. Speech-to-text adds noise to every one of these measures, so the output
// is explicitly weak, corroborating evidence — never a standalone finding.

import type { SpeechSnapshot } from '../speech-core/index.ts';
import type { StyleBaseline, StyleDeviation, StyleMetrics } from '../domain/types.ts';

export const MIN_BASELINE_SESSIONS = 3;

const STYLE_CAVEAT =
  'Speech-to-text introduces noise into sentence length, vocabulary and pause measures. ' +
  'A style shift can also mean a different topic, a good or bad day, or simply growth. ' +
  'Treat this only as weak corroboration alongside independent signals.';

const FLOORS: StyleMetrics = {
  meanUnitLength: 2,
  vocabularyVariety: 0.04,
  longWordRate: 0.03,
  fillerPerMin: 0.8,
  pausesPerMin: 1.2,
  wpm: 12,
};

export function metricsFromSnapshot(s: SpeechSnapshot): StyleMetrics {
  const minutes = Math.max(1 / 60, s.elapsedMs / 60_000);
  return {
    meanUnitLength: s.vocabulary.meanUnitLength ?? 0,
    vocabularyVariety: s.vocabulary.variety ?? 0,
    longWordRate: s.vocabulary.longWordRate ?? 0,
    fillerPerMin: s.fillers.hardPerMin ?? 0,
    pausesPerMin: s.pauses.count / minutes,
    wpm: s.pace.wpm ?? 0,
  };
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function sd(xs: number[], m: number): number {
  if (xs.length < 2) return 0;
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1));
}

const KEYS: Array<keyof StyleMetrics> = [
  'meanUnitLength', 'vocabularyVariety', 'longWordRate', 'fillerPerMin', 'pausesPerMin', 'wpm',
];

/** Build a baseline from a participant's prior sessions' final snapshots. */
export function computeStyleBaseline(
  participantId: string,
  priorSnapshots: SpeechSnapshot[],
): Omit<StyleBaseline, 'id' | 'createdAt'> {
  const rows = priorSnapshots.filter((s) => (s.transcript?.wordCount ?? 0) >= 40).map(metricsFromSnapshot);
  const metrics = {} as StyleMetrics;
  const spread = {} as StyleMetrics;
  for (const k of KEYS) {
    const xs = rows.map((r) => r[k]);
    const m = mean(xs);
    metrics[k] = m;
    spread[k] = Math.max(sd(xs, m), FLOORS[k]);
  }
  return { participantId, sessionsUsed: rows.length, metrics, spread };
}

/** Describe how the current snapshot deviates from the baseline. */
export function styleDeviation(current: SpeechSnapshot, baseline: StyleBaseline | null): StyleDeviation {
  if (!baseline || baseline.sessionsUsed < MIN_BASELINE_SESSIONS) {
    return {
      hasBaseline: false,
      sessionsInBaseline: baseline?.sessionsUsed ?? 0,
      perMetric: [],
      overallShift: 0,
      reasons: [`insufficient history — need ${MIN_BASELINE_SESSIONS} prior sessions, have ${baseline?.sessionsUsed ?? 0}`],
      caveat: STYLE_CAVEAT,
    };
  }
  const cur = metricsFromSnapshot(current);
  const perMetric = KEYS.map((k) => {
    const z = (cur[k] - baseline.metrics[k]) / Math.max(baseline.spread[k], FLOORS[k]);
    return { metric: k, current: round(cur[k]), baseline: round(baseline.metrics[k]), z: round(z) };
  });
  const overallShift = Math.min(1, mean(perMetric.map((m) => Math.abs(m.z))) / 3);
  const reasons = perMetric
    .filter((m) => Math.abs(m.z) >= 2)
    .map((m) => `${label(m.metric)} is ${m.z > 0 ? 'above' : 'below'} this speaker's norm by ${Math.abs(m.z).toFixed(1)}σ`);
  return { hasBaseline: true, sessionsInBaseline: baseline.sessionsUsed, perMetric, overallShift: round(overallShift), reasons, caveat: STYLE_CAVEAT };
}

function label(k: string): string {
  return {
    meanUnitLength: 'sentence length',
    vocabularyVariety: 'vocabulary variety',
    longWordRate: 'longer-word rate',
    fillerPerMin: 'filler rate',
    pausesPerMin: 'pause rate',
    wpm: 'speaking pace',
  }[k] ?? k;
}
function round(x: number): number {
  return Math.round(x * 100) / 100;
}
