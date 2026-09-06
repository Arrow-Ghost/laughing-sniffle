// Replay archive bundle (spec §64).
//
// One deterministic JSON object with everything needed to reconstruct a session
// after the event: transcript, metrics, timeline, evaluations, consensus, coach
// plans, artefact hashes and the audit trail. A content hash over the
// canonicalised body makes tampering detectable. Integrity detail is included in
// full only for a reviewer; other callers get the redacted case views.

import { createHash } from 'node:crypto';
import type { StorageProvider } from '../storage/StorageProvider.ts';
import type { IntegrityEngine } from '../integrity/index.ts';
import type { Id, ReplayBundle } from '../domain/types.ts';
import { computeConsensus } from './consensus.ts';

/** Stable JSON: object keys sorted recursively so the hash is order-independent. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

export function buildReplayBundle(
  storage: StorageProvider,
  integrity: IntegrityEngine,
  sessionId: Id,
  opts: { includeIntegrityDetail: boolean },
): ReplayBundle {
  const session = storage.getSession(sessionId);
  if (!session) throw new Error('session not found');

  const participant = session.participantId ? storage.getParticipant(session.participantId) : null;
  const event = session.eventId ? storage.getEvent(session.eventId) : null;
  const rounds = session.eventId ? storage.listRoundsByEvent(session.eventId) : [];
  const segments = storage.listSegments(sessionId);
  const metrics = storage.listMetrics(sessionId);
  const timeline = storage.listTimeline(sessionId);
  const evaluations = storage.listEvaluations(sessionId);
  const consensus = evaluations.length ? computeConsensus(storage, sessionId) : null;
  const coachPlans = storage.listCoachPlansBySession(sessionId);
  const artifacts = storage.getSessionArtifacts(sessionId);
  const audit = storage.listAuditBySession(sessionId);

  const rawCases = storage.listIntegrityCasesBySession(sessionId);
  const integrityCases: unknown[] = opts.includeIntegrityDetail
    ? rawCases
    : rawCases.map((c) => integrity.redactedCase(c.id));

  const body = {
    bundleVersion: 1 as const,
    session,
    participant,
    event,
    rounds,
    segments,
    metrics,
    timeline,
    evaluations,
    consensus,
    integrityCases,
    coachPlans,
    artifacts,
    audit,
    redacted: !opts.includeIntegrityDetail,
  };

  const contentHash = createHash('sha256').update(canonical(body)).digest('hex');

  return { ...body, generatedAt: Date.now(), contentHash };
}
