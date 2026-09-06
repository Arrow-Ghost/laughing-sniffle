// Judge one rubric criterion. Structured JSON out (spec §20, §27). Performance
// only — the prompt explicitly bars any comment on outside assistance (spec §101).

import type { Part } from '@google/generative-ai';
import type { RubricCriterion } from '../../domain/types.ts';

export interface JudgeCriterionInput {
  criterion: RubricCriterion;
  eventType: string;
  transcriptLines: string;
  metricsDigest: string;
  timelineDigest: string;
  glossText?: string; // English gloss when the answer isn't in English (spec §12)
  primaryLang?: string;
}

export function judgeCriterionParts(i: JudgeCriterionInput): Part[] {
  const c = i.criterion;
  const anchors = Object.entries(c.anchors)
    .map(([k, v]) => `  ${k} = ${v}`)
    .join('\n');
  return [
    {
      text: [
        `You are an impartial ${i.eventType} judge scoring ONE criterion of a performance.`,
        '',
        `CRITERION: ${c.name}`,
        `What it measures: ${c.description}`,
        c.evaluationRules ? `How to apply it: ${c.evaluationRules}` : '',
        `Scale: integer ${c.scaleMin} to ${c.scaleMax}. Anchors:`,
        anchors,
        '',
        'Rules:',
        `- Score ONLY "${c.name}". Ignore every other dimension.`,
        '- Ground the score in specific moments. Quote them verbatim from the transcript.',
        '- Use the [MM:SS] markers in the transcript for approximate timestamps.',
        '- The speech metrics and timeline below are context you MAY cite as evidence.',
        '- Do NOT comment on whether the speaker used notes, AI, the internet, or any outside',
        '  assistance. That is a separate system and out of scope here.',
        '- If the response is too thin to judge this criterion well, say so and set confidence low.',
        '',
        'Return STRICT JSON, nothing else, matching exactly:',
        '{',
        `  "score": <integer ${c.scaleMin}..${c.scaleMax}>,`,
        '  "confidence": "low" | "medium" | "high",',
        '  "evidence": [ { "startMs": <int>, "endMs": <int>, "quote": "<verbatim from transcript>", "reason": "<why it supports the score>" } ],',
        '  "strengths": [ "<short>" ],',
        '  "weaknesses": [ "<short>" ],',
        '  "reasoning": "<2-4 sentences tying the score to the anchors>"',
        '}',
        'evidence: 1 to 4 items. strengths / weaknesses: 0 to 4 each.',
        '',
        `EVENT TYPE: ${i.eventType}`,
        i.primaryLang && !i.primaryLang.startsWith('en')
          ? `\nThe answer was delivered in "${i.primaryLang}". Judge the SUBSTANCE as delivered — do not mark it down for not being in English, and do not judge the translation's phrasing. An English gloss is provided only for your reference.`
          : '',
        '',
        'SPEECH METRICS (context):',
        i.metricsDigest,
        '',
        'TIMELINE (context):',
        i.timelineDigest || '(none)',
        '',
        i.glossText ? `ENGLISH GLOSS (reference only, not authoritative):\n${i.glossText}\n` : '',
        'TRANSCRIPT (original — authoritative):',
        i.transcriptLines || '(no transcript captured)',
      ]
        .filter(Boolean)
        .join('\n'),
    },
  ];
}

export const JUDGE_REPAIR_HINT =
  'Your previous reply was not valid JSON of the required shape. Reply again with only the JSON object: ' +
  '{ "score": int, "confidence": "low"|"medium"|"high", "evidence": [...], "strengths": [...], "weaknesses": [...], "reasoning": string }.';
