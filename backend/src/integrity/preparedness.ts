// Preparedness detection (spec §38). This is an OBSERVATION about delivery, not
// an integrity finding. "Prepared" is not "AI-assisted". It becomes an integrity
// signal only when the event prohibits prepared material AND at least one
// independent signal is already present (handled in the engine).

import type { SpeechSnapshot } from '../speech-core/index.ts';
import type { PreparednessAnalysis } from '../domain/types.ts';

const NOTE =
  'Preparation is not evidence of unauthorised assistance. A rehearsed speaker looks like this. ' +
  'This is only relevant where the event prohibits prepared material and other signals also point to review.';

export function analyzePreparedness(s: SpeechSnapshot): PreparednessAnalysis {
  const words = s.transcript?.wordCount ?? 0;
  if (words < 60) {
    return { classification: 'uncertain', rehearsedScore: 0, indicators: ['too little speech to assess'], note: NOTE };
  }

  const speakingMin = Math.max(1 / 60, s.delivery.speakingSecondsTotal / 60);
  const pauseRate = s.pauses.count / speakingMin;
  const fillerRate = s.fillers.hardPerMin ?? 0;
  const paceShifts = s.timeline.filter((e) => e.kind.startsWith('pace-')).length;

  const indicators: string[] = [];
  let score = 0;

  if (fillerRate < 1.2) {
    score += 0.3;
    indicators.push(`very few hesitations (${fillerRate.toFixed(1)}/min)`);
  }
  if (pauseRate < 4) {
    score += 0.25;
    indicators.push(`few pauses (${pauseRate.toFixed(1)}/min of speech)`);
  }
  if ((s.delivery.talkRatio ?? 0) > 0.85) {
    score += 0.2;
    indicators.push('sustained delivery with little silence');
  }
  if (s.pace.descriptor === 'steady' && paceShifts <= 1) {
    score += 0.15;
    indicators.push('even pace throughout');
  }
  const variety = s.vocabulary.variety ?? 0;
  if (variety >= 0.7 && variety <= 0.92) {
    score += 0.1;
    indicators.push('stable, consistent vocabulary');
  }

  const classification =
    score >= 0.7 ? 'highly-rehearsed' : score >= 0.4 ? 'prepared' : score >= 0.15 ? 'spontaneous' : 'spontaneous';

  return { classification, rehearsedScore: Math.round(score * 100) / 100, indicators, note: NOTE };
}
