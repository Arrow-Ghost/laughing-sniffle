// SpeechCore — the facade around audio ingest, the streaming analyzer, and the
// transcription pump. The transport layer (WS handler) talks to this and nothing
// deeper. Judge / Integrity engines will read `snapshot()` and subscribe to
// `transcript` / `timeline`.

import { EventEmitter } from 'node:events';
// analyzer.js / metrics.js stay JavaScript for now — pure, fully unit-tested,
// no value in a risky hand-migration. allowJs picks them up.
import { SessionAnalyzer } from './analyzer.js';
import { TranscriptionPump } from './transcription-pump.ts';
import type { AIGateway } from '../ai/AIGateway.ts';

export type TranscriptSourceMode = 'server' | 'browser';

export interface SpeechSnapshot {
  elapsedMs: number;
  transcript: { text: string; wordCount: number; source: string };
  pace: { wpm: number | null; descriptor: string | null; window: string; ready: boolean };
  pauses: { count: number; meanMs: number | null; longestMs: number | null };
  fillers: {
    ready: boolean;
    hardPerMin: number | null;
    softPerMin: number | null;
    hardExamples: string[];
    softExamples: string[];
    note: string;
  };
  vocabulary: {
    variety: number | null;
    varietyBasis: string;
    longWordRate: number | null;
    distinctWords: number;
    meanUnitLength: number | null;
    meanUnitBasis: 'punctuation' | 'pauses';
  };
  delivery: { talkRatio: number | null; speakingSecondsTotal: number };
  answerLatency:
    | null
    | { pending: true; sinceMs: number }
    | { pending: false; latencyMs: number }
    | { pending: false; alreadySpeaking: true };
  timeline: Array<{ t: number; kind: string; meta?: Record<string, unknown> }>;
}

export interface SpeechCoreOptions {
  sampleRate?: number;
  transcriptSource: TranscriptSourceMode;
  ai: AIGateway | null;
  multilingual?: boolean;
  languages?: string[];
  expectSpeakers?: number;
}

type SpeechEvents = {
  transcript: [{ text: string; isFinal: boolean; source: TranscriptSourceMode; lang?: string; speaker?: string }];
  timeline: [{ kind: string; [k: string]: unknown }];
  fallback: [string];
};

export class SpeechCore extends EventEmitter<SpeechEvents> {
  readonly sessionId: string;
  private readonly analyzer: InstanceType<typeof SessionAnalyzer>;
  private pump: TranscriptionPump | null = null;
  private source: TranscriptSourceMode;
  private readonly sr: number;

  constructor(sessionId: string, opts: SpeechCoreOptions) {
    super();
    this.sessionId = sessionId;
    this.sr = opts.sampleRate ?? 16_000;
    this.source = opts.transcriptSource;
    this.analyzer = new SessionAnalyzer({
      sampleRate: this.sr,
      onPause: () => this.pump?.triggerPauseFlush(),
    });
    this.analyzer.setTranscriptSource(this.source);

    if (this.source === 'server' && opts.ai?.enabled()) {
      this.pump = new TranscriptionPump(
        opts.ai,
        {
          onDelta: (text, meta) => {
            this.analyzer.pushTranscript({ text, isFinal: true });
            this.emit('transcript', { text, isFinal: true, source: 'server', lang: meta?.lang, speaker: meta?.speaker });
          },
          onFallback: (message) => {
            this.source = 'browser';
            this.analyzer.setTranscriptSource('browser');
            this.pump = null;
            this.emit('fallback', message);
          },
        },
        this.sr,
        { multilingual: opts.multilingual, languages: opts.languages, expectSpeakers: opts.expectSpeakers },
      );
    } else {
      this.source = 'browser';
      this.analyzer.setTranscriptSource('browser');
    }
  }

  get transcriptSource(): TranscriptSourceMode {
    return this.source;
  }

  get transcribing(): boolean {
    return this.pump?.inFlight ?? false;
  }

  /** int16: little-endian mono PCM16 at the core's sample rate. */
  ingestAudio(int16: Buffer): void {
    const samples = new Float32Array(Math.floor(int16.length / 2));
    for (let i = 0; i < samples.length; i += 1) samples[i] = int16.readInt16LE(i * 2) / 32768;
    this.analyzer.pushAudio({ samples });
    this.pump?.push(int16);
  }

  ingestBrowserTranscript(text: string, isFinal: boolean): void {
    if (this.source !== 'browser') return;
    this.analyzer.pushTranscript({ text, isFinal });
    if (isFinal && text.trim()) this.emit('transcript', { text, isFinal: true, source: 'browser' });
  }

  markQuestion(label: string): void {
    this.analyzer.markQuestion({ label });
    this.emit('timeline', { kind: 'question', label });
  }

  now(): number {
    return this.analyzer.now();
  }

  snapshot(): SpeechSnapshot {
    return this.analyzer.snapshot() as SpeechSnapshot;
  }

  energyTimeline(): Array<{ t: number; v: number }> {
    return this.analyzer.energyTimeline();
  }

  async flush(): Promise<void> {
    await this.pump?.flush();
  }

  stop(): void {
    this.pump?.stop();
    this.pump = null;
  }

  export(): unknown {
    return this.analyzer.export();
  }
}
