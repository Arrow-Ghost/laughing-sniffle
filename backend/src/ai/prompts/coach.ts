// Coaching-notes prompt. Delivery and structure only; forbids any speculation
// about tools used or any rating of authorship (spec §89, §102, §114).

import type { Part } from '@google/generative-ai';

export interface CoachInput {
  transcript: string;
  metrics: unknown;
}

export function coachParts({ transcript, metrics }: CoachInput): Part[] {
  return [
    {
      text: [
        'You are a supportive speech and debate coach writing private notes FOR THE SPEAKER',
        'to review after their own practice session. Base your notes only on delivery and',
        'structure. Do NOT speculate about whether the speaker used notes, AI, or any tool,',
        'and do NOT rate authenticity or authorship — that is out of scope and unreliable.',
        '',
        'Return STRICT JSON, no prose outside it, matching:',
        '{ "summary": string, "notes": string[] }',
        'where "notes" has 3 to 5 short, concrete, encouraging items — what landed well and',
        'one or two things to try next time (signposting, pacing on a specific passage,',
        'handling a pause). Reference phrases from the transcript where useful.',
        '',
        `Descriptive metrics from the session: ${JSON.stringify(metrics)}`,
        '',
        `Transcript:\n${transcript}`,
      ].join('\n'),
    },
  ];
}

export const COACH_REPAIR_HINT =
  'Your previous reply was not valid JSON of the form { "summary": string, "notes": string[] }. ' +
  'Reply again with only that JSON object.';
