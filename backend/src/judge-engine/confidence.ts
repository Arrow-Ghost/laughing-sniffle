// Deterministic confidence guard (spec §93). Sits on top of the model's own
// self-reported confidence and can only ever LOWER it, with a stated reason.

import type { Confidence } from '../domain/types.ts';

const RANK: Record<Confidence, number> = { low: 0, medium: 1, high: 2 };
const NAME: readonly Confidence[] = ['low', 'medium', 'high'];

export function capConfidence(a: Confidence, b: Confidence): Confidence {
  return NAME[Math.min(RANK[a], RANK[b])]!;
}

export interface EvidenceContext {
  wordCount: number;
  speakingSeconds: number;
  evidenceCount: number;
  evaluated: boolean;
}

export function guardConfidence(
  model: Confidence,
  ctx: EvidenceContext,
): { confidence: Confidence; reasons: string[] } {
  if (!ctx.evaluated) return { confidence: 'low', reasons: ['automated evaluation unavailable'] };

  const reasons: string[] = [];
  let cap: Confidence = 'high';

  if (ctx.wordCount < 40) {
    cap = capConfidence(cap, 'low');
    reasons.push(`very short response (${ctx.wordCount} words)`);
  } else if (ctx.wordCount < 120) {
    cap = capConfidence(cap, 'medium');
    reasons.push(`short response (${ctx.wordCount} words)`);
  }
  if (ctx.speakingSeconds < 20) {
    cap = capConfidence(cap, 'medium');
    reasons.push(`limited speaking time (${Math.round(ctx.speakingSeconds)}s)`);
  }
  if (ctx.evidenceCount === 0) {
    cap = capConfidence(cap, 'low');
    reasons.push('no supporting evidence located');
  }

  const confidence = capConfidence(model, cap);
  if (RANK[confidence] < RANK[model] && reasons.length === 0) reasons.push('capped by the evidence guard');
  return { confidence, reasons };
}
