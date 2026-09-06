// Session integrity (spec §44-46). SHA-256 over the immutable artefacts so a
// later change is detectable, plus consistency checks over the recorded
// transcript/timeline. This is NOT tamper-proof — browser capture cannot be
// (spec §47). An anomaly is never on its own a finding; the wording says so.

import { createHash } from 'node:crypto';
import type { SpeechSnapshot } from '../speech-core/index.ts';
import type {
  SessionArtifacts,
  SessionIntegrityAnomaly,
  SessionIntegrityReport,
  TranscriptSegment,
} from '../domain/types.ts';

const HONEST_NOTE =
  'Browser-based capture cannot be made tamper-proof. These checks look for internal ' +
  'inconsistencies in what was recorded — they do not prove a recording was altered, and ' +
  'no anomaly here is on its own a finding. Send anything flagged to human review.';

function sha256(v: unknown): string {
  return createHash('sha256').update(JSON.stringify(v)).digest('hex');
}

/** Canonicalise then hash the three immutable artefacts of a finished session. */
export function computeArtifactHashes(input: {
  segments: TranscriptSegment[];
  snapshot: unknown;
  timeline: unknown;
}): { transcriptHash: string; snapshotHash: string; timelineHash: string } {
  const canonSegments = input.segments
    .filter((s) => s.isFinal)
    .map((s) => ({ t0: s.t0, t1: s.t1, source: s.source, text: s.text.trim() }));
  return {
    transcriptHash: sha256(canonSegments),
    snapshotHash: sha256(input.snapshot ?? null),
    timelineHash: sha256(input.timeline ?? null),
  };
}

function norm(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function checkSessionIntegrity(input: {
  segments: TranscriptSegment[];
  snapshot: SpeechSnapshot | null;
  timeline: unknown;
  artifacts: SessionArtifacts | null;
  reconnects: number;
  audioGaps: Array<{ atMs: number; durMs: number }>;
}): SessionIntegrityReport {
  const anomalies: SessionIntegrityAnomaly[] = [];
  const segs = input.segments.filter((s) => s.isFinal).sort((a, b) => a.t0 - b.t0);

  // 1. hash comparison — recompute and diff against what was stored at end.
  const fresh = computeArtifactHashes({ segments: input.segments, snapshot: input.snapshot, timeline: input.timeline });
  if (input.artifacts) {
    if (input.artifacts.transcriptHash !== fresh.transcriptHash) {
      anomalies.push({ type: 'hash-mismatch', atMs: null, severity: 'concern', detail: 'the stored transcript no longer matches its recorded hash' });
    }
    if (input.artifacts.timelineHash !== fresh.timelineHash) {
      anomalies.push({ type: 'hash-mismatch', atMs: null, severity: 'notable', detail: 'the stored timeline no longer matches its recorded hash' });
    }
  }

  // 2. timestamp continuity + duplicated segments + timing vs. audio.
  for (let i = 0; i < segs.length; i += 1) {
    const s = segs[i]!;
    const prev = segs[i - 1];
    if (prev) {
      if (s.t0 + 400 < prev.t1) {
        anomalies.push({ type: 'timestamp-discontinuity', atMs: s.t0, severity: 'notable', detail: `segment starts ${Math.round(prev.t1 - s.t0)}ms before the previous one ends` });
      } else if (s.t0 - prev.t1 > 12_000) {
        anomalies.push({ type: 'timestamp-discontinuity', atMs: prev.t1, severity: 'info', detail: `${Math.round((s.t0 - prev.t1) / 1000)}s gap between recorded segments` });
      }
      if (norm(prev.text) === norm(s.text) && norm(s.text).length > 15) {
        anomalies.push({ type: 'duplicated-segment', atMs: s.t0, severity: 'notable', detail: 'an identical segment appears twice in a row' });
      }
    }
    const durS = (s.t1 - s.t0) / 1000;
    const words = s.text.trim().split(/\s+/).filter(Boolean).length;
    if (durS >= 1 && words >= 4) {
      const wpm = (words / durS) * 60;
      if (wpm > 450 || wpm < 20) {
        anomalies.push({ type: 'timing-inconsistent-with-audio', atMs: s.t0, severity: 'notable', detail: `${words} words in ${durS.toFixed(1)}s implies ${Math.round(wpm)} wpm` });
      }
    }
  }

  // 3. connection events recorded during the session.
  if (input.reconnects > 0) {
    anomalies.push({ type: 'reconnect', atMs: null, severity: input.reconnects > 2 ? 'notable' : 'info', detail: `${input.reconnects} mid-session reconnection${input.reconnects === 1 ? '' : 's'}` });
  }
  for (const g of input.audioGaps) {
    anomalies.push({ type: 'audio-stream-gap', atMs: g.atMs, severity: g.durMs > 8000 ? 'notable' : 'info', detail: `no audio for ${(g.durMs / 1000).toFixed(1)}s while the session was live` });
  }

  return {
    hashed: Boolean(input.artifacts),
    transcriptHash: input.artifacts?.transcriptHash ?? fresh.transcriptHash,
    anomalies,
    note: HONEST_NOTE,
  };
}
