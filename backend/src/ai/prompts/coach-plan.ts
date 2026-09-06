// Turns the Judge Engine's exact weaknesses into a short, actionable plan. The
// weaknesses are given verbatim (spec §89) — the model must not invent new ones,
// only organise and coach on these.

import type { Part } from '@google/generative-ai';
import type { CoachPersona } from '../../domain/types.ts';
import { PERSONA_STYLE } from '../../coach/personas.ts';

export interface CoachPlanInput {
  persona: CoachPersona;
  eventType: string;
  overallScore: number;
  scaleMax: number;
  strengths: string[];
  weaknesses: Array<{ criterionName: string; score: number; text: string }>;
}

export function coachPlanParts(i: CoachPlanInput): Part[] {
  const w = i.weaknesses.map((x) => `- [${x.criterionName} ${x.score}/${i.scaleMax}] ${x.text}`).join('\n');
  return [
    {
      text: [
        `You are coaching a ${i.eventType} performer after their round.`,
        `Voice: ${PERSONA_STYLE[i.persona]}`,
        '',
        `Overall: ${i.overallScore}/${i.scaleMax}.`,
        i.strengths.length ? `Judge noted these strengths:\n${i.strengths.map((s) => `- ${s}`).join('\n')}` : '',
        i.weaknesses.length ? `Judge flagged these weaknesses (do NOT add new ones — coach on exactly these):\n${w}` : 'The judge flagged no specific weaknesses.',
        '',
        'Return STRICT JSON:',
        '{ "summary": string, "keepDoing": string[] }',
        'summary: 3-5 sentences that turn the flagged weaknesses into a clear practice focus, in the voice above.',
        'keepDoing: 1-3 short items drawn from the strengths (or [] if none were noted).',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

export const COACH_PLAN_REPAIR =
  'Reply again with only { "summary": string, "keepDoing": string[] } and nothing else.';
