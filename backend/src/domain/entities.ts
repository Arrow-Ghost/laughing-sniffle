// Factories + hand validators for the foundation entities. No external schema
// library (spec §27 permits hand JSON validators). Each factory fills id +
// createdAt + defaults and throws ValidationError on bad input.

import { randomUUID } from 'node:crypto';
import {
  DEFAULT_POLICY,
  type AuditEvent,
  type Confidence,
  type Consent,
  type Event,
  type EventPolicy,
  type EventType,
  type Id,
  type Participant,
  type Round,
  type Session,
  type SessionMode,
  type TimelineEvent,
  type TimelineEventType,
  type TimelineSeverity,
  type TimelineSource,
  type TranscriptSegment,
  type TranscriptSource,
} from './types.ts';

export class ValidationError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(`${field}: ${message}`);
    this.name = 'ValidationError';
    this.field = field;
  }
}

const now = () => Date.now();
const id = () => randomUUID();

function str(field: string, v: unknown, { min = 1, max = 2000 } = {}): string {
  if (typeof v !== 'string') throw new ValidationError(field, 'must be a string');
  const t = v.trim();
  if (t.length < min) throw new ValidationError(field, `must be at least ${min} char(s)`);
  if (t.length > max) throw new ValidationError(field, `must be at most ${max} chars`);
  return t;
}
function oneOf<T extends string>(field: string, v: unknown, allowed: readonly T[]): T {
  if (typeof v !== 'string' || !allowed.includes(v as T)) {
    throw new ValidationError(field, `must be one of ${allowed.join(', ')}`);
  }
  return v as T;
}
function optId(field: string, v: unknown): Id | null {
  if (v == null) return null;
  return str(field, v, { min: 1, max: 128 });
}
function num(field: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new ValidationError(field, 'must be a finite number');
  return v;
}

export const EVENT_TYPES = [
  'debate', 'interview', 'speech', 'presentation', 'hackathon-pitch', 'mun', 'panel', 'custom',
] as const satisfies readonly EventType[];

export const SESSION_MODES = [
  'debate-practice', 'interview-prep', 'speech-coaching',
] as const satisfies readonly SessionMode[];

export function normalizePolicy(input: unknown): EventPolicy {
  const p = (input ?? {}) as Partial<EventPolicy>;
  return {
    aiAssistance: oneOf('policy.aiAssistance', p.aiAssistance ?? DEFAULT_POLICY.aiAssistance, [
      'allowed', 'disclosure', 'restricted', 'prohibited',
    ]),
    internet: oneOf('policy.internet', p.internet ?? DEFAULT_POLICY.internet, ['allowed', 'prohibited']),
    preparedNotes: oneOf('policy.preparedNotes', p.preparedNotes ?? DEFAULT_POLICY.preparedNotes, [
      'allowed', 'prohibited',
    ]),
    externalSources: oneOf('policy.externalSources', p.externalSources ?? DEFAULT_POLICY.externalSources, [
      'allowed', 'prohibited',
    ]),
    maxDurationSec:
      p.maxDurationSec == null ? null : num('policy.maxDurationSec', p.maxDurationSec),
    languages: Array.isArray(p.languages) ? p.languages.map((l, i) => str(`policy.languages[${i}]`, l, { max: 20 })) : [],
    integrityReview: typeof p.integrityReview === 'boolean' ? p.integrityReview : DEFAULT_POLICY.integrityReview,
  };
}

export function createEvent(input: {
  name: unknown;
  type: unknown;
  description?: unknown;
  policy?: unknown;
  rubricId?: unknown;
}): Event {
  return {
    id: id(),
    createdAt: now(),
    name: str('name', input.name, { max: 200 }),
    type: oneOf('type', input.type, EVENT_TYPES),
    description: input.description == null ? '' : str('description', input.description, { min: 0, max: 4000 }),
    status: 'draft',
    policy: normalizePolicy(input.policy),
    rubricId: optId('rubricId', input.rubricId),
  };
}

export function createRound(input: { eventId: unknown; index: unknown; name?: unknown }): Round {
  const index = num('index', input.index);
  if (index < 1 || !Number.isInteger(index)) throw new ValidationError('index', 'must be a positive integer');
  return {
    id: id(),
    createdAt: now(),
    eventId: str('eventId', input.eventId, { max: 128 }),
    index,
    name: input.name == null ? `Round ${index}` : str('name', input.name, { max: 200 }),
    status: 'pending',
  };
}

export function createParticipant(input: {
  eventId?: unknown;
  displayName: unknown;
  seat?: unknown;
}): Participant {
  return {
    id: id(),
    createdAt: now(),
    eventId: optId('eventId', input.eventId),
    displayName: str('displayName', input.displayName, { max: 200 }),
    seat: input.seat == null ? null : str('seat', input.seat, { max: 100 }),
  };
}

const DEFAULT_LABELS: Record<SessionMode, string> = {
  'debate-practice': 'Debate practice',
  'interview-prep': 'Interview prep',
  'speech-coaching': 'Speech coaching',
};

export function normalizeConsent(input: unknown): Consent {
  const c = (input ?? {}) as Partial<Consent>;
  if (c.speakerAcknowledged !== true) {
    throw new ValidationError(
      'consent.speakerAcknowledged',
      'a session cannot start until the person being recorded has acknowledged consent',
    );
  }
  return {
    speakerAcknowledged: true,
    secondPartyAcknowledged: c.secondPartyAcknowledged === true,
    acknowledgedAt: new Date().toISOString(),
  };
}

export function createSession(input: {
  mode: unknown;
  label?: unknown;
  consent: unknown;
  eventId?: unknown;
  roundId?: unknown;
  participantId?: unknown;
  languages?: unknown;
  expectSpeakers?: unknown;
}): Session {
  const mode = oneOf('mode', input.mode, SESSION_MODES);
  const languages = Array.isArray(input.languages)
    ? input.languages.map((l, i) => str(`languages[${i}]`, l, { max: 12 }).toLowerCase()).slice(0, 6)
    : [];
  const expectSpeakers =
    input.expectSpeakers == null ? 1 : Math.min(8, Math.max(1, Math.round(num('expectSpeakers', input.expectSpeakers))));
  return {
    id: id(),
    createdAt: now(),
    eventId: optId('eventId', input.eventId),
    roundId: optId('roundId', input.roundId),
    participantId: optId('participantId', input.participantId),
    mode,
    label: input.label == null || input.label === '' ? DEFAULT_LABELS[mode] : str('label', input.label, { max: 200 }),
    consent: normalizeConsent(input.consent),
    status: 'live',
    startedAt: now(),
    endedAt: null,
    languages,
    expectSpeakers,
  };
}

export function createTranscriptSegment(input: {
  sessionId: Id;
  source: TranscriptSource;
  t0: number;
  t1: number;
  text: string;
  isFinal: boolean;
  lang?: string | null;
  speakerId?: Id | null;
}): TranscriptSegment {
  return {
    id: id(),
    createdAt: now(),
    sessionId: str('sessionId', input.sessionId, { max: 128 }),
    source: oneOf('source', input.source ?? 'gemini', ['gemini', 'browser', 'server', 'groq']),
    t0: num('t0', input.t0),
    t1: num('t1', input.t1),
    text: str('text', input.text, { min: 0, max: 20000 }),
    isFinal: Boolean(input.isFinal),
    lang: input.lang ?? null,
    speakerId: input.speakerId ?? null,
  };
}

const TIMELINE_TYPES: readonly TimelineEventType[] = [
  'question', 'pause', 'long-pause', 'pace-shift', 'strong-moment', 'weakness', 'claim',
  'evidence', 'rebuttal', 'time-warning', 'source-match', 'cross-match', 'ai-signal', 'language-switch',
];

export function createTimelineEvent(input: {
  sessionId: Id;
  atMs: number;
  endMs?: number | null;
  type: TimelineEventType;
  severity?: TimelineSeverity;
  confidence?: Confidence;
  source?: TimelineSource;
  description: string;
  linkedText?: string | null;
}): TimelineEvent {
  return {
    id: id(),
    createdAt: now(),
    sessionId: str('sessionId', input.sessionId, { max: 128 }),
    atMs: num('atMs', input.atMs),
    endMs: input.endMs == null ? null : num('endMs', input.endMs),
    type: oneOf('type', input.type, TIMELINE_TYPES),
    severity: oneOf('severity', input.severity ?? 'info', ['info', 'notable', 'concern']),
    confidence: oneOf('confidence', input.confidence ?? 'medium', ['low', 'medium', 'high']),
    source: oneOf('source', input.source ?? 'speech-core', ['speech-core', 'judge', 'integrity']),
    description: str('description', input.description, { min: 0, max: 2000 }),
    linkedText: input.linkedText ?? null,
  };
}

export function createAuditEvent(input: {
  actor?: string;
  action: string;
  objectType: string;
  objectId: Id;
  sessionId?: Id | null;
  eventId?: Id | null;
  prev?: unknown;
  next?: unknown;
}): AuditEvent {
  return {
    id: id(),
    createdAt: now(),
    actor: input.actor ?? 'system',
    action: str('action', input.action, { max: 100 }),
    objectType: str('objectType', input.objectType, { max: 100 }),
    objectId: str('objectId', input.objectId, { max: 128 }),
    sessionId: input.sessionId ?? null,
    eventId: input.eventId ?? null,
    prev: input.prev ?? null,
    next: input.next ?? null,
  };
}
