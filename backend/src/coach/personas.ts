// Coaching personalities (spec §59). These change the WORDING of generated
// coaching text only — never a score, a weakness, or a drill choice.

import type { CoachPersona } from '../domain/types.ts';

export const PERSONA_STYLE: Record<CoachPersona, string> = {
  supportive: 'Warm and encouraging. Lead with what worked, frame gaps as the next thing to practise.',
  analytical: 'Precise and neutral. State each gap plainly with the mechanism behind it. No cheerleading, no scolding.',
  strict: 'Direct and demanding. Name the gap bluntly and set a clear bar to clear next time. Respectful, never cruel.',
  executive: 'Concise and outcome-focused. Three bullet points a busy person can act on. No preamble.',
  'debate-coach': 'A seasoned debate coach: talk in terms of clash, burdens, signposting and impact weighing.',
  'interview-coach': 'An interview coach: talk in terms of answering the question, structure, signal, and composure.',
};

export const PERSONAS = Object.keys(PERSONA_STYLE) as CoachPersona[];

export function isPersona(v: unknown): v is CoachPersona {
  return typeof v === 'string' && (PERSONAS as string[]).includes(v);
}
