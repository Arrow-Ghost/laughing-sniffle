import { API_BASE } from './api';

/* ---- shared fetch with a bearer token (dev/cross-origin friendly) ---- */
const TOKEN_KEY = 'shadowadj_token';
export const getToken = (): string | null =>
  typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_KEY);
export const setToken = (t: string | null): void => {
  if (typeof localStorage === 'undefined') return;
  if (t) localStorage.setItem(TOKEN_KEY, t);
  else localStorage.removeItem(TOKEN_KEY);
};

async function jf<T>(path: string, init?: RequestInit): Promise<T> {
  const tok = getToken();
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(tok ? { authorization: `Bearer ${tok}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `${r.status} ${path}`);
  return r.json() as Promise<T>;
}

/* ---- auth ---- */
export type Role = 'admin' | 'judge' | 'reviewer' | 'participant';
export interface PublicUser {
  id: string;
  createdAt: number;
  name: string;
  email: string | null;
  role: Role;
  participantId: string | null;
}
export interface Me {
  authEnabled: boolean;
  role: Role;
  dev: boolean;
  user: PublicUser | null;
}

export const getMe = () => jf<Me>('/api/auth/me');
export async function login(email: string, password: string): Promise<Me> {
  const r = await jf<{ token: string; user: PublicUser }>('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  setToken(r.token);
  return getMe();
}
export async function register(body: { name: string; email: string; password: string; role?: Role }): Promise<Me> {
  const r = await jf<{ token: string; user: PublicUser; bootstrap: boolean }>('/api/auth/register', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  setToken(r.token);
  return getMe();
}
export async function logout(): Promise<void> {
  await jf('/api/auth/logout', { method: 'POST' }).catch(() => {});
  setToken(null);
}
export const listUsers = () => jf<PublicUser[]>('/api/auth/users');

/* ---- events ---- */
export interface EventRow {
  id: string;
  name: string;
  type: string;
  status: string;
}
export const listEvents = () => jf<EventRow[]>('/api/events');

/* ---- leaderboard ---- */
export type RiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';
export interface LeaderboardRow {
  rank: number;
  participantId: string;
  participantLabel: string;
  sessionsScored: number;
  overallScore: number | null;
  scaleMax: number;
  integrityStatus: 'clear' | 'under-review';
  admin?: {
    judgeCount: number;
    consensusSpread: number | null;
    agreement: 'strong' | 'moderate' | 'weak' | null;
    integrityRisk: RiskLevel | null;
    openCaseIds: string[];
    perCriterion: Array<{ criterionName: string; mean: number }>;
  };
}
export interface Leaderboard {
  eventId: string;
  eventName: string;
  view: 'public' | 'admin';
  generatedAt: number;
  scaleMax: number;
  rows: LeaderboardRow[];
  note: string;
}
export const getLeaderboard = (eventId: string, view: 'public' | 'admin') =>
  jf<Leaderboard>(`/api/events/${eventId}/leaderboard?view=${view}`);

/* ---- analytics ---- */
export interface EventAnalytics {
  eventId: string;
  eventName: string;
  generatedAt: number;
  participants: number;
  sessions: number;
  sessionsEnded: number;
  evaluations: number;
  finalEvaluations: number;
  scoreDistribution: {
    scaleMax: number;
    count: number;
    mean: number | null;
    median: number | null;
    stddev: number | null;
    histogram: Array<{ bucket: string; count: number }>;
  };
  criterionAverages: Array<{ criterionName: string; mean: number; n: number }>;
  judgeStats: Array<{
    judgeId: string;
    judgeType: 'ai' | 'human';
    evaluations: number;
    meanScoreGiven: number;
    meanDeviationFromConsensus: number;
  }>;
  integritySummary: {
    cases: number;
    byRisk: Record<RiskLevel, number>;
    byStatus: Record<string, number>;
    confirmedByHuman: number;
    note: string;
  };
  coaching: { plans: number; drills: number; participantsWithPlan: number };
}
export const getAnalytics = (eventId: string) => jf<EventAnalytics>(`/api/events/${eventId}/analytics`);

/* ---- consensus ---- */
export interface SessionConsensus {
  sessionId: string;
  rubricName: string | null;
  scaleMax: number;
  judgeCount: number;
  humanJudgeCount: number;
  overallMean: number;
  overallSpread: number;
  agreement: 'strong' | 'moderate' | 'weak';
  divergentCriteria: string[];
  outlierJudges: Array<{ evaluationId: string; judgeId: string | null; meanDeviation: number }>;
  criteria: Array<{
    criterionName: string;
    mean: number;
    min: number;
    max: number;
    spread: number;
    diverges: boolean;
    perJudge: Array<{ evaluationId: string; judgeId: string | null; score: number }>;
  }>;
  note: string;
}
export const getConsensus = (sessionId: string) => jf<SessionConsensus>(`/api/sessions/${sessionId}/consensus`);

/* ---- tie-break ---- */
export interface TieBreakResult {
  rulesApplied: string[];
  entries: Array<{
    participantLabel: string;
    rank: number;
    overallScore: number;
    tiedWithPrevious: boolean;
    brokenBy: string | null;
    trace: string[];
  }>;
  note: string;
}
export const runTiebreak = (eventId: string, rules: { criterionPriority?: string[] } = {}) =>
  jf<TieBreakResult>(`/api/events/${eventId}/tiebreak`, { method: 'POST', body: JSON.stringify({ rules }) });

/* ---- audit ---- */
export interface AuditRow {
  id: string;
  createdAt: number;
  actor: string;
  action: string;
  objectType: string;
  objectId: string;
}
export const getEventAudit = (eventId: string) => jf<AuditRow[]>(`/api/events/${eventId}/audit`);

/* ---- jobs ---- */
export interface Job {
  id: string;
  kind: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  maxAttempts: number;
  enqueuedAt: number;
  finishedAt: number | null;
  error: string | null;
}
export const listJobs = () => jf<Job[]>('/api/jobs?limit=25');
export const jobStats = () => jf<{ queued: number; running: number; done: number; failed: number; total: number }>('/api/jobs/stats');
export const enqueueJob = (kind: string, payload: Record<string, unknown>) =>
  jf<Job>('/api/jobs', { method: 'POST', body: JSON.stringify({ kind, payload }) });

export const RISK_CLS: Record<RiskLevel, string> = {
  LOW: 'text-white/50',
  MODERATE: 'text-cyan',
  HIGH: 'text-amber',
  CRITICAL: 'text-rose',
};
