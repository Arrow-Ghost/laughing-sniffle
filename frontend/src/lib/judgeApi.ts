import { API_BASE } from './api';

export type Confidence = 'low' | 'medium' | 'high';

export interface EvidenceRef {
  startMs: number;
  endMs: number;
  quote: string;
  reason: string;
}
export interface CriterionScore {
  criterionId: string;
  criterionName: string;
  weight: number;
  score: number;
  aiScore: number | null;
  humanScore: number | null;
  confidence: Confidence;
  confidenceReasons: string[];
  evidence: EvidenceRef[];
  strengths: string[];
  weaknesses: string[];
  reasoning: string;
  overriddenBy: string | null;
  overrideReason: string | null;
}
export interface JudgeEvaluation {
  id: string;
  createdAt: number;
  sessionId: string;
  rubricId: string;
  rubricName: string;
  judgeType: 'ai' | 'human';
  status: 'draft' | 'final';
  scaleMax: number;
  overallScore: number;
  overallConfidence: Confidence;
  criteria: CriterionScore[];
  notes: string | null;
}
export interface TimelineEvent {
  id: string;
  atMs: number;
  endMs: number | null;
  type: string;
  severity: 'info' | 'notable' | 'concern';
  confidence: Confidence;
  source: 'speech-core' | 'judge' | 'integrity';
  description: string;
  linkedText: string | null;
}

async function jf<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status} ${path}`);
  return r.json() as Promise<T>;
}

export const listEvaluations = (sessionId: string) =>
  jf<JudgeEvaluation[]>(`/api/sessions/${sessionId}/evaluations`);
export const getEvaluation = (id: string) => jf<JudgeEvaluation>(`/api/evaluations/${id}`);
export const runEvaluation = (sessionId: string, rubricId?: string) =>
  jf<JudgeEvaluation>(`/api/sessions/${sessionId}/evaluations`, {
    method: 'POST',
    body: JSON.stringify(rubricId ? { rubricId } : {}),
  });
export const overrideCriterion = (
  evaluationId: string,
  criterionId: string,
  humanScore: number,
  reason: string,
  reviewer = 'reviewer',
) =>
  jf<JudgeEvaluation>(`/api/evaluations/${evaluationId}/criteria/${criterionId}`, {
    method: 'PATCH',
    body: JSON.stringify({ humanScore, reason, reviewer }),
  });
export const finalizeEvaluation = (evaluationId: string, notes: string, reviewer = 'reviewer') =>
  jf<JudgeEvaluation>(`/api/evaluations/${evaluationId}/finalize`, {
    method: 'POST',
    body: JSON.stringify({ notes, reviewer }),
  });
export const reopenEvaluation = (evaluationId: string, reviewer = 'reviewer') =>
  jf<JudgeEvaluation>(`/api/evaluations/${evaluationId}/reopen`, {
    method: 'POST',
    body: JSON.stringify({ reviewer }),
  });
export const getTimeline = (sessionId: string) =>
  jf<TimelineEvent[]>(`/api/sessions/${sessionId}/timeline`);
export const listRubrics = () => jf<{ id: string; name: string }[]>(`/api/rubrics`);

export interface LanguageProfile {
  primary: string;
  languages: Array<{ lang: string; share: number; spans: number }>;
  switches: number;
  codeSwitching: boolean;
  outsidePolicy: string[];
}
export const getLanguage = (sessionId: string) => jf<LanguageProfile>(`/api/sessions/${sessionId}/language`);

export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}
