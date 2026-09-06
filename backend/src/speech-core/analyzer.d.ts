// Type surface for analyzer.js (kept as JavaScript on purpose — pure, fully
// unit-tested). Consumers get a typed contract; internals stay untouched.

export interface AnalyzerSnapshot {
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

export class SessionAnalyzer {
  constructor(opts?: { sampleRate?: number });
  now(): number;
  setTranscriptSource(src: string): void;
  pushAudio(input: { samples: Float32Array; at?: number }): void;
  pushTranscript(input: { text: string; isFinal?: boolean; t0?: number; t1?: number }): void;
  markQuestion(input?: { label?: string; at?: number }): void;
  snapshot(): AnalyzerSnapshot;
  energyTimeline(maxPoints?: number): Array<{ t: number; v: number }>;
  export(): unknown;
}
