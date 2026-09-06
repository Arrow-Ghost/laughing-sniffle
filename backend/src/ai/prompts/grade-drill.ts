import type { Part } from '@google/generative-ai';
import type { DrillType } from '../../domain/types.ts';
import { DRILL_CATALOG } from '../../coach/drills.ts';

export interface GradeDrillInput {
  type: Exclude<DrillType, 'retry'>;
  fromWeakness: string;
  prompt: string;
  responseTranscript: string;
  metricsDigest: string;
  scaleMax: number;
}

export function gradeDrillParts(i: GradeDrillInput): Part[] {
  return [
    {
      text: [
        `Grade this attempt at a "${DRILL_CATALOG[i.type].label}" drill on ONE thing only:`,
        `did it improve on the weakness "${i.fromWeakness}" — i.e. ${DRILL_CATALOG[i.type].goal}?`,
        '',
        `Drill prompt: ${i.prompt}`,
        `Speech metrics: ${i.metricsDigest}`,
        `Attempt transcript:\n${i.responseTranscript || '(no transcript captured)'}`,
        '',
        `Return STRICT JSON: { "score": <integer 1..${i.scaleMax}>, "targetMet": boolean, "feedback": string }`,
        'feedback: 2-3 sentences, concrete, tied to what they actually said. targetMet: did they clearly address the weakness.',
      ].join('\n'),
    },
  ];
}

export const GRADE_DRILL_REPAIR =
  'Reply again with only { "score": int, "targetMet": boolean, "feedback": string }.';
