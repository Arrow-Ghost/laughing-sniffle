// SessionManager — owns the live runtime for each session and its bridge to
// durable storage. A RuntimeSession holds only volatile objects (the SpeechCore,
// connected sockets); the Session entity and everything derived from it live in
// the StorageProvider.

import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { SpeechCore, type TranscriptSourceMode } from './speech-core/index.ts';
import type { AIGateway } from './ai/AIGateway.ts';
import type { StorageProvider } from './storage/StorageProvider.ts';
import { createSession, createTimelineEvent, createTranscriptSegment, ValidationError } from './domain/entities.ts';
import { computeArtifactHashes } from './integrity/session-integrity.ts';
import type { Id, Session, TimelineEventType, TimelineSeverity } from './domain/types.ts';
import { HttpError } from './errors.ts';
import { audit } from './audit.ts';
import { config, serverTranscription } from './config.ts';
import { languageProfile } from './i18n/language.ts';
import { encode, type ServerMessage, type TimerState } from './shared/protocol.ts';

const RUNTIME_TTL_MS = 3 * 60 * 60 * 1000;
const METRIC_INTERVAL_MS = 10_000;
const LINGER_MS = 60_000;

export interface RuntimeSession {
  entity: Session;
  core: SpeechCore;
  clients: Set<WebSocket>;
  lastCoaching: { summary: string; notes: string[]; at: number } | null;
  broadcast: (msg: ServerMessage) => void;
  timerState: () => TimerState;
  _metricTimer: NodeJS.Timeout;
  _lastSegT: number;
  _seenTimeline: Set<string>;
  _connectCount: number;
  _speakers: Map<string, Id>; // transcription speaker label -> stable id
}

// analyzer timeline kinds -> persisted TimelineEvent shape (spec §21)
const TIMELINE_MAP: Record<string, { type: TimelineEventType; severity: TimelineSeverity; label: string }> = {
  question: { type: 'question', severity: 'info', label: 'question asked' },
  pause: { type: 'pause', severity: 'info', label: 'pause' },
  'long-pause': { type: 'long-pause', severity: 'notable', label: 'long pause' },
  'pace-fast': { type: 'pace-shift', severity: 'notable', label: 'faster passage' },
  'pace-measured': { type: 'pace-shift', severity: 'info', label: 'measured passage' },
};

export interface CreateSessionInput {
  mode: unknown;
  label?: unknown;
  consent: unknown;
  eventId?: unknown;
  roundId?: unknown;
  participantId?: unknown;
  transcriptSource?: 'server' | 'browser';
  maxDurationSec?: number | null;
  languages?: unknown;
  expectSpeakers?: unknown;
}

export class SessionManager {
  private readonly runtime = new Map<Id, RuntimeSession>();
  private readonly storage: StorageProvider;
  private readonly ai: AIGateway;

  constructor(storage: StorageProvider, ai: AIGateway) {
    this.storage = storage;
    this.ai = ai;
    setInterval(() => this.sweep(), 60_000).unref?.();
  }

  create(input: CreateSessionInput): RuntimeSession {
    let entity: Session;
    try {
      entity = createSession(input);
    } catch (err) {
      if (err instanceof ValidationError) {
        throw new HttpError(err.field.startsWith('consent') ? 403 : 400, err.message);
      }
      throw err;
    }

    // Honour an event's policy duration if one is attached.
    let limitSec = typeof input.maxDurationSec === 'number' ? input.maxDurationSec : null;
    if (entity.eventId) {
      const ev = this.storage.getEvent(entity.eventId);
      if (ev?.policy.maxDurationSec) limitSec = ev.policy.maxDurationSec;
    }

    this.storage.createSession(entity);
    audit(this.storage, {
      action: 'session.started',
      objectType: 'session',
      objectId: entity.id,
      sessionId: entity.id,
      eventId: entity.eventId,
      next: { mode: entity.mode, label: entity.label },
    });

    const wantServer = input.transcriptSource !== 'browser' && serverTranscription;
    // Multilingual transcription kicks in when the session (or its event) lists
    // languages, or when more than one speaker is expected (spec §12, §14).
    const eventLangs = entity.eventId ? (this.storage.getEvent(entity.eventId)?.policy.languages ?? []) : [];
    const languages = entity.languages.length ? entity.languages : eventLangs;
    const multilingual =
      config.multilingual !== 'off' &&
      (languages.some((l) => l && !l.startsWith('en')) || entity.expectSpeakers > 1 || config.multilingual === 'always');
    const core = new SpeechCore(entity.id, {
      transcriptSource: (wantServer ? 'server' : 'browser') as TranscriptSourceMode,
      ai: this.ai.enabled() ? this.ai : null,
      multilingual,
      languages,
      expectSpeakers: entity.expectSpeakers,
    });

    const startedAt = entity.startedAt ?? Date.now();
    const rt: RuntimeSession = {
      entity,
      core,
      clients: new Set(),
      lastCoaching: null,
      _lastSegT: 0,
      _seenTimeline: new Set(),
      _connectCount: 0,
      _speakers: new Map(),
      _metricTimer: undefined as unknown as NodeJS.Timeout,
      broadcast: (msg) => {
        const str = encode(msg);
        for (const c of rt.clients) if (c.readyState === WebSocket.OPEN) c.send(str);
      },
      timerState: () => {
        const elapsedSec = Math.floor(core.now() / 1000);
        if (limitSec == null) return { elapsedSec, limitSec: null, remainingSec: null, state: 'none' };
        const remainingSec = limitSec - elapsedSec;
        const state: TimerState['state'] =
          remainingSec <= 0 ? 'overtime' : remainingSec <= 30 ? 'warning' : 'running';
        return { elapsedSec, limitSec, remainingSec, state };
      },
    };

    core.on('transcript', ({ text, isFinal, source, lang, speaker }) => {
      if (isFinal) {
        const t1 = core.now();
        try {
          this.storage.appendSegment(
            createTranscriptSegment({
              sessionId: entity.id,
              source: source === 'server' ? 'gemini' : 'browser',
              t0: rt._lastSegT,
              t1,
              text,
              isFinal: true,
              lang: lang ?? null,
              speakerId: speaker ? this.speakerId(rt, speaker) : null,
            }),
          );
        } catch (err) {
          console.error('[session] failed to persist segment', err);
        }
        rt._lastSegT = t1;
      }
      rt.broadcast({ type: 'transcript', text, isFinal, source });
    });
    core.on('timeline', (event) => rt.broadcast({ type: 'timeline', event }));
    core.on('fallback', (message) => {
      audit(this.storage, {
        action: 'transcription.fallback',
        objectType: 'session',
        objectId: entity.id,
        sessionId: entity.id,
      });
      rt.broadcast({ type: 'transcription-fallback', message });
    });

    rt._metricTimer = setInterval(() => {
      try {
        this.storage.appendMetric({
          id: randomUUID(),
          createdAt: Date.now(),
          sessionId: entity.id,
          atMs: core.now(),
          kind: 'periodic',
          snapshot: core.snapshot(),
        });
        this.syncTimeline(rt);
      } catch {
        /* non-fatal */
      }
    }, METRIC_INTERVAL_MS);
    rt._metricTimer.unref?.();

    void startedAt;
    this.runtime.set(entity.id, rt);
    return rt;
  }

  getRuntime(id: Id): RuntimeSession {
    const rt = this.runtime.get(id);
    if (!rt) throw new HttpError(404, 'session not found or no longer live');
    return rt;
  }

  private speakerId(rt: RuntimeSession, label: string): Id {
    const key = label.trim() || 'Speaker A';
    let sid = rt._speakers.get(key);
    if (!sid) {
      sid = `spk_${rt._speakers.size + 1}`;
      rt._speakers.set(key, sid);
    }
    return sid;
  }

  /** Descriptive language profile for a session (spec §12, §13). */
  languageProfile(id: Id) {
    const session = this.getEntity(id);
    const policyLangs = session.eventId
      ? (this.storage.getEvent(session.eventId)?.policy.languages ?? [])
      : session.languages;
    return languageProfile(this.storage.listSegments(id), policyLangs);
  }

  /** Best-effort speaker breakdown (spec §14). Always low confidence. */
  diarization(id: Id) {
    this.getEntity(id);
    const segs = this.storage.listSegments(id).filter((s) => s.isFinal);
    const by = new Map<string, { count: number; ms: number; turns: number }>();
    let prev: string | null = null;
    for (const s of segs) {
      const k = s.speakerId ?? 'spk_1';
      const cur = by.get(k) ?? { count: 0, ms: 0, turns: 0 };
      cur.count += 1;
      cur.ms += Math.max(0, s.t1 - s.t0);
      if (k !== prev) cur.turns += 1;
      by.set(k, cur);
      prev = k;
    }
    const rt = this.runtime.get(id);
    const labelFor = (sid: string) =>
      rt ? [...rt._speakers.entries()].find(([, v]) => v === sid)?.[0] ?? sid : sid;
    return {
      speakers: [...by.entries()].map(([id2, v]) => ({
        id: id2,
        label: labelFor(id2),
        segmentCount: v.count,
        speakingMs: Math.round(v.ms),
        turns: v.turns,
      })),
      confidence: 'low' as const,
      note:
        'Speaker labels come from the transcription model only — no dedicated diarizer. ' +
        'Treat turn counts as approximate.',
    };
  }

  /** Original transcript with an English (or `target`) gloss alongside — never
   *  in place (spec §12). */
  async translatedTranscript(id: Id, target = 'en') {
    this.getEntity(id);
    const segs = this.storage.listSegments(id).filter((s) => s.isFinal);
    const out: Array<{ t0: number; t1: number; lang: string | null; text: string; translation: string | null; speakerId: Id | null }> = [];
    for (const s of segs) {
      const needs = s.lang && !s.lang.split('-')[0]!.toLowerCase().startsWith(target.split('-')[0]!.toLowerCase());
      let translation: string | null = null;
      if (needs && this.ai.enabled()) {
        try {
          translation = await this.ai.translate(s.text, target);
        } catch {
          translation = null;
        }
      }
      out.push({ t0: s.t0, t1: s.t1, lang: s.lang, text: s.text, translation, speakerId: s.speakerId });
    }
    return out;
  }

  /** Append any analyzer timeline markers not yet in the persisted evidence
   *  timeline. Idempotent — de-duplicated by (t, kind). */
  private syncTimeline(rt: RuntimeSession): void {
    for (const e of rt.core.snapshot().timeline) {
      const key = `${Math.round(e.t)}:${e.kind}`;
      if (rt._seenTimeline.has(key)) continue;
      rt._seenTimeline.add(key);
      const map = TIMELINE_MAP[e.kind];
      if (!map) continue;
      const wpm = typeof e.meta?.wpm === 'number' ? ` (${e.meta.wpm} wpm)` : '';
      const dur = typeof e.meta?.durationMs === 'number' ? ` (${(e.meta.durationMs / 1000).toFixed(1)}s)` : '';
      try {
        this.storage.appendTimelineEvent(
          createTimelineEvent({
            sessionId: rt.entity.id,
            atMs: e.t,
            type: map.type,
            severity: map.severity,
            confidence: 'high',
            source: 'speech-core',
            description: `${map.label}${wpm}${dur}`,
          }),
        );
      } catch {
        /* non-fatal */
      }
    }
  }

  getEntity(id: Id): Session {
    const s = this.storage.getSession(id);
    if (!s) throw new HttpError(404, 'session not found');
    return s;
  }

  async end(id: Id): Promise<unknown> {
    const rt = this.runtime.get(id);
    if (!rt) {
      this.getEntity(id); // 404 if unknown
      return this.export(id);
    }
    await rt.core.flush();
    clearInterval(rt._metricTimer);
    this.syncTimeline(rt);
    const endedAt = Date.now();
    this.storage.endSession(id, endedAt);

    // Hash the immutable artefacts so a later change is detectable (spec §44).
    try {
      const segs = this.storage.listSegments(id);
      const snap = rt.core.snapshot();
      const tl = this.storage.listTimeline(id);
      this.storage.putSessionArtifacts({
        id: randomUUID(),
        createdAt: endedAt,
        sessionId: id,
        ...computeArtifactHashes({ segments: segs, snapshot: snap, timeline: tl }),
        segmentCount: segs.filter((s) => s.isFinal).length,
        audioMsTotal: rt.core.now(),
        reconnects: Math.max(0, rt._connectCount - 1),
      });
    } catch (err) {
      console.error('[session] failed to hash artefacts', err);
    }
    try {
      this.storage.appendMetric({
        id: randomUUID(),
        createdAt: endedAt,
        sessionId: id,
        atMs: rt.core.now(),
        kind: 'final',
        snapshot: rt.core.snapshot(),
      });
    } catch {
      /* non-fatal */
    }
    audit(this.storage, {
      action: 'session.ended',
      objectType: 'session',
      objectId: id,
      sessionId: id,
      eventId: rt.entity.eventId,
    });
    rt.core.stop();
    rt.entity.status = 'ended';
    rt.entity.endedAt = endedAt;
    const exported = this.export(id);
    setTimeout(() => this.runtime.delete(id), LINGER_MS).unref?.();
    return exported;
  }

  export(id: Id): unknown {
    const entity = this.getEntity(id);
    const rt = this.runtime.get(id);
    const head = { id, mode: entity.mode, label: entity.label, consent: entity.consent };
    if (rt) return { ...head, ...(rt.core.export() as object) };

    const segments = this.storage.listSegments(id);
    const finalM = this.storage.latestMetric(id);
    const snap = (finalM?.snapshot ?? null) as { timeline?: unknown } | null;
    return {
      ...head,
      durationMs: finalM?.atMs ?? 0,
      transcriptSource: entity.mode,
      transcript: segments.map((s) => ({ t0: s.t0, t1: s.t1, text: s.text, isFinal: s.isFinal })),
      timeline: Array.isArray(snap?.timeline) ? snap.timeline : [],
      questionMarks: [],
      finalSnapshot: snap,
    };
  }

  auditTrail(id: Id) {
    return this.storage.listAuditBySession(id);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, rt] of this.runtime) {
      if (now - rt.entity.createdAt > RUNTIME_TTL_MS) {
        clearInterval(rt._metricTimer);
        rt.core.stop();
        this.runtime.delete(id);
      }
    }
  }
}
