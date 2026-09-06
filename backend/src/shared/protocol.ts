// WebSocket message contract (spec §75). Source of truth for both ends; the
// frontend keeps a hand mirror at frontend/src/lib/protocol.ts until a shared
// workspace is introduced. Wire shapes are unchanged from v0 so no client
// migration is needed — this module adds names, types, and validation.

export const PROTOCOL_VERSION = 1;

/* ---------------------------- client -> server ---------------------------- */
// Binary frames carry raw little-endian PCM16 mono audio and are handled
// outside this union.

export interface ClientHello {
  type: 'hello';
  transcriptSource?: 'server' | 'browser';
}
export interface ClientTranscript {
  type: 'transcript';
  text: string;
  isFinal?: boolean;
}
export interface ClientQuestion {
  type: 'question';
  label?: string;
}
export interface ClientEnd {
  type: 'end';
}
export type ClientMessage = ClientHello | ClientTranscript | ClientQuestion | ClientEnd;

/* ---------------------------- server -> client ---------------------------- */

export interface ServerReady {
  type: 'ready';
  geminiEnabled: boolean;
  defaultTranscription: 'server' | 'browser';
}
export interface ServerConfig {
  type: 'config';
  transcriptSource: 'server' | 'browser';
}
export interface ServerTick {
  type: 'tick';
  snapshot: unknown;
  energy: unknown;
  transcribing: boolean;
  timer?: TimerState;
}
export interface ServerTranscript {
  type: 'transcript';
  text: string;
  isFinal: boolean;
  source: 'server' | 'browser';
}
export interface ServerTimeline {
  type: 'timeline';
  event: { kind: string; [k: string]: unknown };
}
export interface ServerNotice {
  type: 'notice';
  message: string;
}
export interface ServerFallback {
  type: 'transcription-fallback';
  message: string;
}
export interface ServerEnded {
  type: 'ended';
  export: unknown;
}
export interface ServerError {
  type: 'error';
  message: string;
}
export type ServerMessage =
  | ServerReady
  | ServerConfig
  | ServerTick
  | ServerTranscript
  | ServerTimeline
  | ServerNotice
  | ServerFallback
  | ServerEnded
  | ServerError;

export interface TimerState {
  elapsedSec: number;
  limitSec: number | null;
  remainingSec: number | null;
  state: 'running' | 'warning' | 'overtime' | 'none';
}

/* ------------------------------- validation ------------------------------ */

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Parse a JSON string from a client. Returns null for anything malformed or
 *  not a recognised message — the caller ignores those, as before. */
export function parseClientMessage(raw: string): ClientMessage | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isObj(msg) || typeof msg.type !== 'string') return null;

  switch (msg.type) {
    case 'hello': {
      const src = msg.transcriptSource;
      if (src !== undefined && src !== 'server' && src !== 'browser') return null;
      return { type: 'hello', transcriptSource: src };
    }
    case 'transcript': {
      if (typeof msg.text !== 'string') return null;
      return { type: 'transcript', text: msg.text, isFinal: msg.isFinal === true };
    }
    case 'question': {
      const label = typeof msg.label === 'string' ? msg.label.slice(0, 80) : undefined;
      return { type: 'question', label };
    }
    case 'end':
      return { type: 'end' };
    default:
      return null;
  }
}

export function encode(msg: ServerMessage): string {
  return JSON.stringify(msg);
}
