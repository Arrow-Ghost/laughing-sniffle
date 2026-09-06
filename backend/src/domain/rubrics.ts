// Rubric factory + validators + presets (spec §17, §18, §68). Judging criteria
// are configuration, never hardcoded into the Judge Engine.

import { randomUUID } from 'node:crypto';
import { ValidationError } from './entities.ts';
import type { EventType, Id, Rubric, RubricCriterion } from './types.ts';

export const DEFAULT_ANCHORS: Record<string, string> = {
  '1': 'extremely weak',
  '3': 'weak',
  '5': 'adequate',
  '7': 'strong',
  '9': 'excellent',
  '10': 'exceptional',
};

interface CriterionInput {
  name: string;
  weight: number;
  description: string;
  evaluationRules?: string;
  dimension?: string | null;
  scaleMin?: number;
  scaleMax?: number;
  anchors?: Record<string, string>;
}

function normCriterion(c: CriterionInput): RubricCriterion {
  if (typeof c.name !== 'string' || !c.name.trim()) throw new ValidationError('criterion.name', 'required');
  if (typeof c.weight !== 'number' || !Number.isFinite(c.weight) || c.weight <= 0 || c.weight > 100) {
    throw new ValidationError(`criterion(${c.name}).weight`, 'must be a positive number (a fraction of 1, or a percentage)');
  }
  const scaleMin = c.scaleMin ?? 1;
  const scaleMax = c.scaleMax ?? 10;
  if (scaleMax <= scaleMin) throw new ValidationError(`criterion(${c.name}).scale`, 'scaleMax must exceed scaleMin');
  return {
    id: randomUUID(),
    name: c.name.trim().slice(0, 120),
    weight: c.weight,
    description: (c.description ?? '').trim().slice(0, 2000),
    scaleMin,
    scaleMax,
    anchors: c.anchors && Object.keys(c.anchors).length ? c.anchors : DEFAULT_ANCHORS,
    evaluationRules: (c.evaluationRules ?? '').trim().slice(0, 4000),
    dimension: c.dimension ?? null,
  };
}

/** Scale criteria weights so they sum to exactly 1. Accepts any positive total —
 *  fractions that already sum to ~1, or percentages that sum to ~100. */
export function normalizeWeights(criteria: RubricCriterion[]): RubricCriterion[] {
  const total = criteria.reduce((a, c) => a + c.weight, 0);
  if (!Number.isFinite(total) || total <= 0) {
    throw new ValidationError('rubric.criteria', 'weights must sum to a positive number');
  }
  return criteria.map((c) => ({ ...c, weight: c.weight / total }));
}

export function createRubric(input: {
  name: unknown;
  eventType: unknown;
  criteria: unknown;
  eventId?: Id | null;
}): Rubric {
  if (typeof input.name !== 'string' || !input.name.trim()) throw new ValidationError('name', 'required');
  const ok: EventType[] = ['debate', 'interview', 'speech', 'presentation', 'hackathon-pitch', 'mun', 'panel', 'custom'];
  if (!ok.includes(input.eventType as EventType)) throw new ValidationError('eventType', `one of ${ok.join(', ')}`);
  if (!Array.isArray(input.criteria) || input.criteria.length === 0) {
    throw new ValidationError('criteria', 'at least one criterion required');
  }
  const criteria = normalizeWeights((input.criteria as CriterionInput[]).map(normCriterion));
  return {
    id: randomUUID(),
    createdAt: Date.now(),
    eventId: input.eventId ?? null,
    name: input.name.trim().slice(0, 200),
    eventType: input.eventType as EventType,
    criteria,
  };
}

/* -------------------------------- presets -------------------------------- */

export const RUBRIC_PRESETS: Record<string, { name: string; eventType: EventType; criteria: CriterionInput[] }> = {
  debate: {
    name: 'Debate — standard',
    eventType: 'debate',
    criteria: [
      { name: 'Argumentation', weight: 0.3, description: 'Strength, originality and logical consistency of the case built.', evaluationRules: 'Reward clear claim–reason–impact chains and internal consistency. Missing links or contradiction lower the score.' },
      { name: 'Evidence', weight: 0.2, description: 'Quality, relevance and integration of supporting material.', evaluationRules: 'Reward specific, relevant support tied to a claim. Assertion without support scores low.' },
      { name: 'Rebuttal', weight: 0.2, description: 'Direct engagement with the opponent’s strongest points.', evaluationRules: 'Reward addressing the opponent’s best argument head-on with a counter and reasoning. Ignoring or strawmanning scores low.' },
      { name: 'Delivery', weight: 0.15, description: 'Pace, clarity, fluency and vocal control.', evaluationRules: 'Use the speech metrics as context: steady pace, controlled pauses, low filler rate support a higher score. Do not penalise a natural accent or dialect.' },
      { name: 'Structure', weight: 0.1, description: 'Signposting and overall organisation.', evaluationRules: 'Reward clear roadmap and transitions. A listener should always know which point is being made.' },
      { name: 'Time Management', weight: 0.05, description: 'Use of the allotted time.', evaluationRules: 'Reward finishing on time with a complete case. Running long or ending far short lowers the score.' },
    ],
  },
  interview: {
    name: 'Interview — standard',
    eventType: 'interview',
    criteria: [
      { name: 'Technical Knowledge', weight: 0.3, description: 'Correctness and depth on the subject asked about.', evaluationRules: 'Reward accurate, appropriately deep answers. Flag factual errors in weaknesses, not as a score of honesty.' },
      { name: 'Problem Solving', weight: 0.25, description: 'Approach to working through the question.', evaluationRules: 'Reward stating assumptions, structured reasoning, and checking the answer.' },
      { name: 'Communication', weight: 0.2, description: 'Clarity and concision of the answer.', evaluationRules: 'Reward a direct answer first, then detail. Use filler and pace metrics as context.' },
      { name: 'Relevance', weight: 0.15, description: 'How well the answer addressed the question asked.', evaluationRules: 'Reward answering the actual question. Tangents lower the score.' },
      { name: 'Confidence', weight: 0.05, description: 'Composure and steadiness under the question.', evaluationRules: 'Use response latency and pause metrics as context. Do not conflate calm with correctness.' },
      { name: 'Consistency', weight: 0.05, description: 'Coherence with earlier answers in the session.', evaluationRules: 'Note conflicting statements as a weakness for human review; do not call it dishonesty.' },
    ],
  },
  speech: {
    name: 'Speech — standard',
    eventType: 'speech',
    criteria: [
      { name: 'Structure', weight: 0.2, description: 'Opening, body, close and transitions.', evaluationRules: 'Reward a clear arc and signposting.' },
      { name: 'Delivery', weight: 0.25, description: 'Pace, pauses, energy and vocal variety.', evaluationRules: 'Use speech metrics as context; reward controlled pace and purposeful pauses.' },
      { name: 'Clarity', weight: 0.2, description: 'How easy the content is to follow.', evaluationRules: 'Reward plain phrasing and one idea at a time.' },
      { name: 'Persuasion', weight: 0.2, description: 'Strength of the case and emotional resonance.', evaluationRules: 'Reward a clear thesis supported through the speech.' },
      { name: 'Pace', weight: 0.1, description: 'Appropriateness of speaking rate for the material.', evaluationRules: 'Judge against the content, not an absolute wpm target.' },
      { name: 'Vocabulary', weight: 0.05, description: 'Range and precision of word choice.', evaluationRules: 'Reward precise, varied language; do not reward complexity for its own sake.' },
    ],
  },
  'hackathon-pitch': {
    name: 'Hackathon pitch — standard',
    eventType: 'hackathon-pitch',
    criteria: [
      { name: 'Problem', weight: 0.15, description: 'Clarity and importance of the problem.', evaluationRules: 'Reward a specific, real problem with a named user.' },
      { name: 'Innovation', weight: 0.2, description: 'Novelty of the approach.', evaluationRules: 'Reward a genuinely different angle; incremental is fine if well argued.' },
      { name: 'Technical Solution', weight: 0.2, description: 'Soundness of what was built.', evaluationRules: 'Reward a working core and honest scope.' },
      { name: 'Feasibility', weight: 0.15, description: 'Realism of the path forward.', evaluationRules: 'Reward awareness of the hard parts.' },
      { name: 'Impact', weight: 0.15, description: 'Size and reachability of the benefit.', evaluationRules: 'Reward a credible impact story.' },
      { name: 'Presentation', weight: 0.1, description: 'Delivery of the pitch.', evaluationRules: 'Use speech metrics as context.' },
      { name: 'Q&A', weight: 0.05, description: 'Handling of questions.', evaluationRules: 'Reward direct, composed answers; use latency metrics as context.' },
    ],
  },
};

export function rubricFromPreset(key: string, eventId: Id | null = null): Rubric {
  const preset = RUBRIC_PRESETS[key];
  if (!preset) throw new ValidationError('preset', `unknown preset "${key}"`);
  return createRubric({ ...preset, eventId });
}
