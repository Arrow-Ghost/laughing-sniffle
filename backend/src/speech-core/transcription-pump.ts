// Server-side transcription pump — extracted verbatim (behaviour-preserving) from
// the old index.js WS handler. Buffers PCM16, sends 6–12s chunks with a 0.8s
// overlap to the AI gateway, de-duplicates the seam, and auto-falls-back to
// browser STT after repeated failures.

import type { AIGateway } from '../ai/AIGateway.ts';

const SR_DEFAULT = 16_000;

export interface DeltaMeta {
  lang?: string;
  speaker?: string;
}

export interface PumpHandlers {
  /** A new finalised transcript delta (already seam-deduplicated). */
  onDelta: (text: string, meta?: DeltaMeta) => void;
  /** Server transcription has given up; switch to browser STT. */
  onFallback: (message: string) => void;
}

export interface PumpOptions {
  /** Multilingual + best-effort diarization via structured transcription. */
  multilingual?: boolean;
  languages?: string[];
  expectSpeakers?: number;
}

/**
 * Append `next` to `acc`, dropping a leading run of up to 12 words from `next`
 * that repeats the tail of `acc` (the re-transcribed overlap window). Always
 * returns a trimmed, single-spaced string.
 */
export function dedupeJoin(acc: string, next: string): string {
  const clean = (s: string): string => (s || '').trim().replace(/\s+/g, ' ');
  if (!acc) return clean(next);
  if (!next) return clean(acc);
  const norm = (w: string): string => w.toLowerCase().replace(/[^\p{L}\p{N}']/gu, '');
  const a = clean(acc).split(' ');
  const b = clean(next).split(' ');
  const maxK = Math.min(12, a.length, b.length);
  let best = 0;
  for (let k = maxK; k >= 1; k -= 1) {
    let mismatches = 0;
    let ok = true;
    for (let i = 0; i < k; i += 1) {
      const wA = norm(a[a.length - k + i] ?? '');
      const wB = norm(b[i] ?? '');
      if (wA !== wB) {
        if (k >= 3 && mismatches === 0 && (wA.startsWith(wB) || wB.startsWith(wA) || levenshteinDist(wA, wB) <= 1)) {
          mismatches += 1;
        } else {
          ok = false;
          break;
        }
      }
    }
    if (ok && (k >= 2 || norm(b[0] ?? '').length >= 3)) {
      best = k;
      break;
    }
  }
  return [...a, ...b.slice(best)].join(' ');
}

function levenshteinDist(s1: string, s2: string): number {
  if (s1 === s2) return 0;
  if (!s1) return s2.length;
  if (!s2) return s1.length;
  if (Math.abs(s1.length - s2.length) > 2) return 99;
  let prev: number[] = Array.from({ length: s2.length + 1 }, (_, i) => i);
  for (let i = 0; i < s1.length; i += 1) {
    const curr: number[] = [i + 1];
    for (let j = 0; j < s2.length; j += 1) {
      const cJ = curr[j] ?? 0;
      const pJ1 = prev[j + 1] ?? 0;
      const pJ = prev[j] ?? 0;
      const cost = s1[i] === s2[j] ? 0 : 1;
      curr.push(Math.min(cJ + 1, pJ1 + 1, pJ + cost));
    }
    prev = curr;
  }
  return prev[s2.length] ?? 99;
}

function dominantLang(utterances: Array<{ text: string; lang: string }>): string | undefined {
  if (utterances.length === 0) return undefined;
  const byLang = new Map<string, number>();
  for (const u of utterances) {
    const l = (u.lang || 'und').split('-')[0]!.toLowerCase();
    byLang.set(l, (byLang.get(l) ?? 0) + u.text.split(/\s+/).length);
  }
  return [...byLang.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}

export class TranscriptionPump {
  inFlight = false;
  private active = true;
  private readonly sr: number;
  private readonly bytesPerS: number;
  private readonly minChunk: number;
  private readonly maxChunk: number;
  private readonly overlapBytes: number;

  private buf: Buffer[] = [];
  private bytes = 0;
  private overlap: Buffer = Buffer.alloc(0);
  private acc = '';
  private failures = 0;

  private readonly ai: AIGateway;
  private readonly handlers: PumpHandlers;
  private readonly opts: PumpOptions;

  constructor(ai: AIGateway, handlers: PumpHandlers, sampleRate = SR_DEFAULT, opts: PumpOptions = {}) {
    this.ai = ai;
    this.handlers = handlers;
    this.opts = opts;
    this.sr = sampleRate;
    this.bytesPerS = sampleRate * 2;
    this.minChunk = this.bytesPerS * 3; // Reduced from 6s to 3s for lower streaming latency
    this.maxChunk = this.bytesPerS * 12;
    this.overlapBytes = Math.floor(this.bytesPerS * 0.8);
  }

  push(int16: Buffer): void {
    if (!this.active) return;
    this.buf.push(int16);
    this.bytes += int16.length;
    void this.run(false);
  }

  /** Triggered on speech pause detected by VAD. Sends buffered speech immediately if >= 1.5s. */
  triggerPauseFlush(): void {
    if (!this.active || this.inFlight) return;
    // Allow flushing if we have at least 1.5 seconds of audio accumulated during a speech pause
    if (this.bytes >= Math.floor(this.bytesPerS * 1.5)) {
      void this.run(true);
    }
  }

  /** Transcribe whatever is still buffered — used on session end. */
  async flush(): Promise<void> {
    if (!this.active) return;
    for (let i = 0; i < 60 && this.inFlight; i += 1) await new Promise((r) => setTimeout(r, 100));
    await this.run(true);
  }

  stop(): void {
    this.active = false;
    this.buf = [];
    this.bytes = 0;
  }

  private async run(force: boolean): Promise<void> {
    if (!this.active || this.inFlight) return;
    if (!force && this.bytes < this.minChunk) return;
    if (force && this.bytes < Math.floor(this.bytesPerS * 1.2)) return; // Require at least 1.2s on forced/pause run
    this.inFlight = true;

    let take = 0;
    const parts: Buffer[] = [];
    while (this.buf.length && take < this.maxChunk) {
      const b = this.buf.shift()!;
      parts.push(b);
      take += b.length;
    }
    this.bytes -= take;
    const body = Buffer.concat(parts);
    const chunk = Buffer.concat([this.overlap, body]);
    this.overlap = body.subarray(Math.max(0, body.length - this.overlapBytes));

    try {
      let text: string;
      let meta: DeltaMeta | undefined;
      if (this.opts.multilingual) {
        const r = await this.ai.transcribeStructured(chunk, this.sr, {
          languages: this.opts.languages,
          expectSpeakers: this.opts.expectSpeakers,
        });
        text = r.text;
        const last = r.utterances[r.utterances.length - 1];
        // whole-delta metadata = the chunk's dominant language + latest speaker
        meta = { lang: dominantLang(r.utterances), speaker: last?.speaker };
      } else {
        text = await this.ai.transcribe(chunk, this.sr);
      }
      this.failures = 0;
      if (text) {
        const merged = dedupeJoin(this.acc, text);
        const delta = merged.slice(this.acc.length).trim();
        this.acc = merged;
        if (delta) this.handlers.onDelta(delta, meta);
      }
    } catch (err) {
      this.failures += 1;
      console.error(`[shadowadj] transcription failed (${this.failures})`, (err as Error).message);
      if (this.failures >= 3) {
        this.stop();
        this.handlers.onFallback(
          'Gemini transcription is unavailable — switched to browser speech recognition.',
        );
      }
    } finally {
      this.inFlight = false;
      if (this.active && this.bytes >= this.minChunk) setImmediate(() => void this.run(false));
    }
  }
}

