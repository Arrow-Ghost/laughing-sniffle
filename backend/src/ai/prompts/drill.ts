import type { Part } from '@google/generative-ai';
import type { DrillDifficulty, DrillType } from '../../domain/types.ts';
import { DRILL_CATALOG } from '../../coach/drills.ts';

export interface DrillPromptInput {
  type: Exclude<DrillType, 'retry'>;
  difficulty: DrillDifficulty;
  fromWeakness: string;
  eventType: string;
  language: string;
  evidenceQuote?: string;
}

export function drillPromptParts(i: DrillPromptInput): Part[] {
  const cat = DRILL_CATALOG[i.type];
  return [
    {
      text: [
        `Write the prompt for a "${cat.label}" speaking drill.`,
        `Goal of the drill: ${cat.goal}.`,
        `It targets this weakness from the participant's last ${i.eventType} round: "${i.fromWeakness}".`,
        i.evidenceQuote ? `A moment the judge flagged: "${i.evidenceQuote}".` : '',
        `Difficulty: ${i.difficulty}. Language: ${i.language}.`,
        '',
        'Output ONLY the drill prompt the participant will see and respond to out loud — a concrete',
        'scenario or claim plus what they must do and the time limit. 2-4 sentences. No preamble,',
        'no "here is your drill", no markdown.',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}
