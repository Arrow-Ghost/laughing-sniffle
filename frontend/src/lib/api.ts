export const API_BASE: string =
  (import.meta as any).env?.PUBLIC_API_BASE || 'http://localhost:8787';

export type SessionMode = 'debate-practice' | 'interview-prep' | 'speech-coaching';

export interface CreatedSession {
  id: string;
  mode: SessionMode;
  label: string;
  consent: { speakerAcknowledged: boolean; secondPartyAcknowledged: boolean; acknowledgedAt: string };
  languages?: string[];
  expectSpeakers?: number;
  wsUrl: string;
}

export async function getHealth(): Promise<{ geminiEnabled: boolean; transcriptionModes: string[] }> {
  const r = await fetch(`${API_BASE}/api/health`);
  if (!r.ok) throw new Error('backend unreachable');
  return r.json();
}

export async function createSession(body: {
  mode: SessionMode;
  label?: string;
  consent: { speakerAcknowledged: boolean; secondPartyAcknowledged: boolean };
  languages?: string[];
  expectSpeakers?: number;
}): Promise<CreatedSession> {
  const r = await fetch(`${API_BASE}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'could not start session');
  return r.json();
}

export async function fetchCoaching(id: string): Promise<{ notes: string; at: number }> {
  const r = await fetch(`${API_BASE}/api/sessions/${id}/coaching`, { method: 'POST' });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'coaching unavailable');
  return r.json();
}

export async function fetchExport(id: string): Promise<any> {
  const r = await fetch(`${API_BASE}/api/sessions/${id}/export`);
  if (!r.ok) throw new Error('export failed');
  return r.json();
}
