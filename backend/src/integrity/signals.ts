// Multi-signal aggregation (spec §36, §39). Independent signals in; a risk LEVEL
// out — never a probability. Hard rule: no single signal can reach HIGH alone
// (enforced by SINGLE_CONTRIBUTION_CAP and asserted in tests).

import type { Confidence, EventPolicy, IntegritySignal, RiskLevel } from '../domain/types.ts';
import { clamp01 } from './text.ts';

// Base weights, on a 0..100 internal scale (spec §39). Configurable.
export const BASE_WEIGHTS: Record<string, number> = {
  'external-source-similarity': 34,
  'cross-participant-similarity': 30,
  'unattributed-distinctive-match': 24,
  'quotation-without-attribution': 12,
  // Phase 4 — deliberately low. Style/preparedness are weak, corroborating
  // evidence only (spec §37, §38). Session anomalies point to review, not guilt.
  'style-discontinuity': 10,
  'preparedness-under-prohibition': 8,
  'session-integrity-anomaly': 14,
};

// Thresholds are REVIEW thresholds, not proof thresholds (spec §39).
export const THRESHOLDS: Array<[number, RiskLevel]> = [
  [70, 'CRITICAL'],
  [45, 'HIGH'],
  [20, 'MODERATE'],
  [0, 'LOW'],
];

// The most any ONE origin may contribute, no matter how many facets it produced.
// 35 < the 45 HIGH threshold, so a single finding (however many correlated
// signals it spawned) tops out at MODERATE. Reaching HIGH needs a second,
// independent origin (spec §36, §39).
export const SINGLE_CONTRIBUTION_CAP = 35;

/** Policy tilts how much weight the external-facing signals carry (spec §97-99). */
function weightsForPolicy(policy: EventPolicy): Record<string, number> {
  const w = { ...BASE_WEIGHTS };
  if (policy.internet === 'prohibited' || policy.externalSources === 'prohibited') {
    w['external-source-similarity'] = (w['external-source-similarity'] ?? 0) * 1.4;
    w['unattributed-distinctive-match'] = (w['unattributed-distinctive-match'] ?? 0) * 1.4;
    w['quotation-without-attribution'] = (w['quotation-without-attribution'] ?? 0) * 1.3;
  }
  if (policy.preparedNotes === 'prohibited') {
    w['preparedness-under-prohibition'] = (w['preparedness-under-prohibition'] ?? 0) * 1.5;
  }
  return w;
}

export interface Aggregation {
  internalScore: number; // 0..100, internal only — never surfaced as a percentage
  riskLevel: RiskLevel;
  confidence: Confidence;
  contributions: Array<{ key: string; contribution: number }>;
}

export function aggregate(signals: IntegritySignal[], policy: EventPolicy): Aggregation {
  const weights = weightsForPolicy(policy);
  const present = signals.filter((s) => s.present && s.strength > 0);

  const contributions = present.map((s) => ({
    key: s.key,
    origin: s.origin,
    contribution: (weights[s.key] ?? 10) * clamp01(s.strength),
  }));

  // Cap the TOTAL contribution from each independent origin, then sum origins.
  const byOrigin = new Map<string, number>();
  for (const c of contributions) byOrigin.set(c.origin, (byOrigin.get(c.origin) ?? 0) + c.contribution);
  let total = 0;
  for (const [, sum] of byOrigin) total += Math.min(sum, SINGLE_CONTRIBUTION_CAP);

  const internalScore = Math.min(100, Math.round(total));
  const riskLevel = THRESHOLDS.find(([t]) => internalScore >= t)![1];

  // Confidence rises with the number of INDEPENDENT corroborating signals and
  // whether each carries concrete evidence (spec §36, §93).
  const corroborated = present.filter((s) => s.evidence.length > 0);
  const independentOrigins = new Set(present.map((s) => s.origin)).size;
  let confidence: Confidence = 'low';
  if (corroborated.length >= 3 && independentOrigins >= 2) confidence = 'high';
  else if (corroborated.length >= 2 && independentOrigins >= 2) confidence = 'medium';

  return { internalScore, riskLevel, confidence, contributions };
}
