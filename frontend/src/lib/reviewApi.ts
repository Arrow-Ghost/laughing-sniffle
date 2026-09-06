import { API_BASE } from './api';
import { clock } from './judgeApi';

export type RiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
export type Confidence = 'low' | 'medium' | 'high';
export type ReviewDecision = 'dismiss' | 'monitor' | 'investigate' | 'confirm';

export interface IntegritySignal {
  key: string;
  label: string;
  present: boolean;
  strength: number;
  origin: string;
  evidence: string[];
}
export interface SourceMatch {
  phrase: string;
  atMs: number | null;
  sourceUrl: string;
  domain: string;
  title: string;
  sourceType: string;
  credibility: number;
  exactSimilarity: number;
  phraseUniqueness: number;
  quotationClass: string;
  significance: number;
}
export interface ParticipantMatch {
  otherSessionId: string;
  otherLabel: string;
  sharedDistinctivePhrases: string[];
  similarity: number;
  note: string;
}
export interface IntegrityReview {
  reviewerId: string;
  decision: ReviewDecision;
  reason: string;
  notes: string | null;
  at: number;
}
export interface StyleDeviation {
  hasBaseline: boolean;
  sessionsInBaseline: number;
  perMetric: Array<{ metric: string; current: number; baseline: number; z: number }>;
  overallShift: number;
  reasons: string[];
  caveat: string;
}
export interface PreparednessAnalysis {
  classification: string;
  rehearsedScore: number;
  indicators: string[];
  note: string;
}
export interface SessionIntegrityAnomaly {
  type: string;
  atMs: number | null;
  severity: 'info' | 'notable' | 'concern';
  detail: string;
}
export interface SessionIntegrityReport {
  hashed: boolean;
  transcriptHash: string | null;
  anomalies: SessionIntegrityAnomaly[];
  note: string;
}
export interface IntegrityAppeal {
  id: string;
  createdAt: number;
  caseId: string;
  submittedBy: string;
  statement: string;
  sourceAttribution: string | null;
  response: { reviewerId: string; decision: string; reason: string; at: number } | null;
}
export interface IntegrityCase {
  id: string;
  createdAt: number;
  sessionId: string;
  eventId: string | null;
  riskLevel: RiskLevel;
  confidence: Confidence;
  signals: IntegritySignal[];
  sourceMatches: SourceMatch[];
  participantMatches: ParticipantMatch[];
  styleAnalysis: StyleDeviation | null;
  preparedness: PreparednessAnalysis;
  sessionIntegrity: SessionIntegrityReport;
  recommendation: string;
  notProvedNote: string;
  searchCoverage: string;
  status: string;
  review: IntegrityReview | null;
}
export interface SourceGraph {
  caseId: string;
  nodes: Array<{ id: string; kind: string; label: string; meta?: Record<string, unknown> }>;
  edges: Array<{ from: string; to: string; kind: string; weight: number; evidence: string }>;
}

async function jf<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status} ${path}`);
  return r.json() as Promise<T>;
}

export const runIntegrity = (sessionId: string) =>
  jf<{ case: IntegrityCase | null; analytics: unknown }>(`/api/sessions/${sessionId}/integrity`, { method: 'POST' });
export const getSessionIntegrity = (sessionId: string) =>
  jf<{ cases: IntegrityCase[]; analytics: unknown[] }>(`/api/sessions/${sessionId}/integrity`);
export const getEventIntegrity = (eventId: string) => jf<IntegrityCase[]>(`/api/events/${eventId}/integrity`);
export const getCase = (id: string) => jf<IntegrityCase>(`/api/integrity-cases/${id}`);
export const reviewCase = (id: string, body: { reviewerId: string; decision: ReviewDecision; reason: string; notes?: string }) =>
  jf<IntegrityCase>(`/api/integrity-cases/${id}/review`, { method: 'POST', body: JSON.stringify(body) });
export const getGraph = (caseId: string) => jf<SourceGraph>(`/api/integrity-cases/${caseId}/graph`);
export const getParticipantView = (caseId: string) => jf<{ appeals: IntegrityAppeal[] } & Record<string, unknown>>(`/api/integrity-cases/${caseId}/participant-view`);
export const submitAppeal = (caseId: string, body: { submittedBy: string; statement: string; sourceAttribution?: string }) =>
  jf<IntegrityAppeal>(`/api/integrity-cases/${caseId}/appeal`, { method: 'POST', body: JSON.stringify(body) });
export const respondAppeal = (appealId: string, body: { reviewerId: string; decision: string; reason: string }) =>
  jf<IntegrityAppeal>(`/api/integrity-appeals/${appealId}/respond`, { method: 'POST', body: JSON.stringify(body) });

export const RISK_COPY: Record<RiskLevel, { label: string; cls: string }> = {
  LOW: { label: 'Low — no action indicated', cls: 'border-white/15 text-white/55' },
  MODERATE: { label: 'Moderate — worth a look', cls: 'border-cyan/40 bg-cyan/10 text-cyan' },
  HIGH: { label: 'High — human review recommended', cls: 'border-amber/40 bg-amber/10 text-amber' },
  CRITICAL: { label: 'Critical — review required before any result', cls: 'border-rose/40 bg-rose/10 text-rose' },
};

export const DECISION_COPY: Record<ReviewDecision, string> = {
  dismiss: 'Dismiss — no concern',
  monitor: 'Monitor — note it, no action now',
  investigate: 'Investigate — needs a closer look',
  confirm: 'Confirm a policy violation (reviewer decision)',
};

export { clock };
