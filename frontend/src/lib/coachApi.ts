import { API_BASE } from './api';
import { clock } from './judgeApi';

export type CoachPersona = 'supportive' | 'analytical' | 'strict' | 'executive' | 'debate-coach' | 'interview-coach';

export interface CoachWeakness {
  criterionId: string;
  criterionName: string;
  score: number;
  weaknessText: string;
  evidence: Array<{ startMs: number; endMs: number; quote: string }>;
  suggestedDrill: string;
}
export interface DrillGrade {
  score: number;
  scaleMax: number;
  targetMet: boolean;
  feedback: string;
  suggestedNextDifficulty: string;
}
export interface Drill {
  id: string;
  planId: string | null;
  sessionId: string;
  type: string;
  difficulty: string;
  fromWeakness: string;
  prompt: string;
  timeLimitSec: number;
  status: string;
  responseSessionId: string | null;
  exchanges: Array<{ role: 'participant' | 'opponent'; text: string; at: number }>;
  grade: DrillGrade | null;
}
export interface CoachPlan {
  id: string;
  sessionId: string;
  participantId: string | null;
  evaluationId: string;
  persona: CoachPersona;
  overallScore: number;
  scaleMax: number;
  focusAreas: string[];
  weaknesses: CoachWeakness[];
  summary: string;
  keepDoing: string[];
  drills?: Drill[];
}
export interface BeforeAfter {
  criteria: Array<{ criterionName: string; before: number | null; after: number | null; delta: number | null }>;
  metrics: Array<{ metric: string; before: number | null; after: number | null; delta: number | null }>;
  overall: { before: number | null; after: number | null; delta: number | null };
}
export interface Progress {
  participantId: string;
  series: Array<{ sessionId: string; at: number; label: string; overallScore: number | null; wpm: number | null; fillerPerMin: number | null; vocabularyVariety: number | null }>;
  trend: Record<string, number | null>;
}

async function jf<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, { ...init, headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status} ${path}`);
  return r.json() as Promise<T>;
}

export const listPlans = (sessionId: string) => jf<CoachPlan[]>(`/api/sessions/${sessionId}/coach/plans`);
export const getPlan = (id: string) => jf<CoachPlan>(`/api/coach-plans/${id}`);
export const buildPlan = (sessionId: string, persona: CoachPersona) =>
  jf<CoachPlan>(`/api/sessions/${sessionId}/coach/plan`, { method: 'POST', body: JSON.stringify({ persona }) });
export const startDrill = (planId: string, weaknessIndex: number, difficulty?: string) =>
  jf<Drill>(`/api/coach-plans/${planId}/drills`, { method: 'POST', body: JSON.stringify({ weaknessIndex, difficulty }) });
export const opponentTurn = (drillId: string, lastArgument: string) =>
  jf<Drill>(`/api/drills/${drillId}/opponent`, { method: 'POST', body: JSON.stringify({ lastArgument }) });
export const attachResponse = (drillId: string, responseSessionId: string) =>
  jf<Drill>(`/api/drills/${drillId}/response`, { method: 'POST', body: JSON.stringify({ responseSessionId }) });
export const gradeDrill = (drillId: string) => jf<Drill>(`/api/drills/${drillId}/grade`, { method: 'POST' });
export const compare = (beforeSessionId: string, afterSessionId: string) =>
  jf<BeforeAfter>(`/api/coach/compare`, { method: 'POST', body: JSON.stringify({ beforeSessionId, afterSessionId }) });
export const getProgress = (participantId: string) => jf<Progress>(`/api/participants/${participantId}/progress`);

export const PERSONAS: CoachPersona[] = ['supportive', 'analytical', 'strict', 'executive', 'debate-coach', 'interview-coach'];
export { clock };
