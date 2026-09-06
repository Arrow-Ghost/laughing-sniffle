import {
  rms,
  tokenize,
  mattr,
  longWordRate,
  countFillers,
  meanUnitLength,
  paceWpm,
  createVad,
  overlapFraction,
} from './metrics.js';

const VIZ_FRAME_MS = 200; // energy-timeline resolution for the sphere/scrubber
const PACE_WINDOW_MS = 30_000;
const PAUSE_MS = 700; // silence longer than this, mid-answer, is a "pause"
const LONG_PAUSE_MS = 2500;
const PACE_EMA = 0.3;
const MIN_SPEECH_MS = 200; // shorter "speech" segments are treated as noise blips
const PAUSE_MERGE_MS = 500; // pauses closer than this collapse into one

// Minimum evidence before a number is shown at all. Below this the snapshot
// reports null and the UI shows "—" rather than a noisy guess.
const MIN_PACE_WORDS = 6;
const MIN_PACE_SPEAKING_S = 4;
const MIN_FILLER_SPEAKING_S = 8;

/**
 * SessionAnalyzer consumes an audio-energy stream and a transcript stream and
 * emits *descriptive* snapshots.
 *
 * Timing is derived from the amount of audio ingested (sample count), so the
 * timeline stays aligned to the audio and the analyzer is deterministic under
 * test. Voice activity is detected by a streaming VAD (adaptive floor +
 * hysteresis + hangover) rather than re-segmenting the whole session each tick.
 *
 * There is deliberately no verdict, no per-person score, and no authorship
 * estimate anywhere in this class.
 */
export class SessionAnalyzer {
  constructor({ sampleRate = 16_000, onPause } = {}) {
    this.sampleRate = sampleRate;
    this.onPause = onPause;
    this.audioMs = 0;

    this._vad = createVad();
    this._speech = []; // finalised speech segments {start,end}, trimmed to last ~90s
    this._speakingMsTotal = 0;
    this._pauseBoundaries = []; // audioMs of each pause >= PAUSE_MS, for clause segmentation

    this._vizFrames = []; // {t, energy} at VIZ_FRAME_MS resolution
    this._vizAccum = { t: 0, peak: 0 };

    this.transcript = []; // {t0, t1, text, isFinal}
    this._wordEvents = []; // {tStart, tEnd, count} — words attributed across the span they were spoken
    this._lastFinalT = 0;
    this._committedWords = 0;

    this.questionMarks = [];
    this.timeline = [];
    this._lastPaceKind = null;
    this._paceEma = null;
    this._transcriptSource = 'none';
  }

  now() {
    return this.audioMs;
  }

  setTranscriptSource(src) {
    this._transcriptSource = src;
  }

  /** samples: Float32Array mono. `at` (tests only) overrides derived timing. */
  pushAudio({ samples, at }) {
    const testMode = at != null;
    const durMs = testMode ? VIZ_FRAME_MS : (samples.length / this.sampleRate) * 1000;
    const t0 = testMode ? at : this.audioMs;
    const t1 = t0 + durMs;
    this.audioMs = testMode ? Math.max(this.audioMs, t1) : this.audioMs + durMs;

    const energy = rms(samples);

    // Streaming VAD.
    const closed = this._vad.push(energy, t0, t1);
    if (closed) this._onSegmentClosed(closed);

    // Viz frame accumulation.
    this._vizAccum.peak = Math.max(this._vizAccum.peak, energy);
    if (t1 - this._vizAccum.t >= VIZ_FRAME_MS) {
      this._vizFrames.push({ t: this._vizAccum.t, energy: this._vizAccum.peak });
      if (this._vizFrames.length > 900) this._vizFrames.shift();
      this._vizAccum = { t: t1, peak: 0 };
    }
  }

  _onSegmentClosed(seg) {
    if (seg.kind === 'speech') {
      // Drop sub-200ms blips (a chair creak, a mic bump) so they don't split a
      // silence into two "pauses" around them.
      if (seg.end - seg.start < MIN_SPEECH_MS) return;
      this._speakingMsTotal += seg.end - seg.start;
      this._speech.push(seg);
      const cutoff = this.audioMs - (PACE_WINDOW_MS + 60_000);
      while (this._speech.length && this._speech[0].end < cutoff) this._speech.shift();
    } else {
      const dur = seg.end - seg.start;
      // Trigger pause callback for dynamic low-latency chunking whenever speech finishes
      if (dur >= 400 && this._speech.length > 0) {
        this.onPause?.();
      }
      // A pause is silence *between* spoken portions. The leading silence before
      // the first word is not a pause (that gap is answer latency instead), so
      // require at least one closed speech segment first. Collapse pauses that
      // land within PAUSE_MERGE_MS of the previous one.
      const lastPause = this._pauseBoundaries[this._pauseBoundaries.length - 1];
      const tooClose = lastPause != null && seg.start - lastPause < PAUSE_MERGE_MS;
      if (dur >= PAUSE_MS && this._speech.length > 0 && !tooClose) {
        this._pauseBoundaries.push(seg.start);
        this.timeline.push({
          t: seg.start,
          kind: dur >= LONG_PAUSE_MS ? 'long-pause' : 'pause',
          meta: { durationMs: Math.round(dur) },
        });
      }
    }
  }

  pushTranscript({ text, isFinal = false, t0, t1 }) {
    if (!text || !text.trim()) return;
    const now = this.now();
    const last = this.transcript[this.transcript.length - 1];
    if (last && !last.isFinal) {
      this.transcript[this.transcript.length - 1] = {
        t0: last.t0,
        t1: t1 ?? now,
        text,
        isFinal,
      };
    } else {
      this.transcript.push({ t0: t0 ?? now, t1: t1 ?? now, text, isFinal });
    }

    if (isFinal) {
      // Attribute this batch's new words uniformly across the interval since the
      // previous final result, so windowed pace reflects when words were spoken
      // rather than when the transcriber flushed them.
      const totalFinalWords = this.transcript
        .filter((s) => s.isFinal)
        .reduce((n, s) => n + tokenize(s.text).length, 0);
      const newWords = Math.max(0, totalFinalWords - this._committedWords);
      this._committedWords = totalFinalWords;
      if (newWords > 0) {
        // Attribute the batch across the span it was likely spoken in. Clamp so a
        // long gap since the last flush (or a mid-answer pause) can't dilute the
        // implied rate below ~100 wpm or inflate it above ~330 wpm.
        const raw = now - this._lastFinalT;
        const span = Math.min(Math.max(raw, newWords * 180), newWords * 600);
        this._wordEvents.push({ tStart: now - span, tEnd: now, count: newWords });
        const cutoff = now - (PACE_WINDOW_MS + 60_000);
        while (this._wordEvents.length && this._wordEvents[0].tEnd < cutoff) {
          this._wordEvents.shift();
        }
      }
      this._lastFinalT = now;
    }
  }

  markQuestion({ label = 'Question', at = this.now() } = {}) {
    this.questionMarks.push({ t: at, label });
    this.timeline.push({ t: at, kind: 'question', meta: { label } });
  }

  // --- derived quantities -------------------------------------------------

  _speakingSecondsInWindow(fromMs, toMs) {
    let ms = 0;
    for (const s of this._speech) {
      const a = Math.max(s.start, fromMs);
      const b = Math.min(s.end, toMs);
      if (b > a) ms += b - a;
    }
    // Include the currently-open speech segment.
    if (this._vad.state === 'speech') {
      const a = Math.max(this._vad.openSince, fromMs);
      const b = Math.min(this.audioMs, toMs);
      if (b > a) ms += b - a;
    }
    return ms / 1000;
  }

  _speakingSecondsTotal() {
    let ms = this._speakingMsTotal;
    if (this._vad.state === 'speech') ms += this.audioMs - this._vad.openSince;
    return ms / 1000;
  }

  _windowedWordCount(fromMs, toMs) {
    let n = 0;
    for (const e of this._wordEvents) {
      n += e.count * overlapFraction(e.tStart, e.tEnd, fromMs, toMs);
    }
    return n;
  }

  _fullText() {
    return this.transcript.map((s) => s.text).join(' ').trim();
  }

  /** Word counts for the spans between detected pauses — clause-length basis. */
  _pauseSpanWordCounts() {
    if (this._pauseBoundaries.length < 2) return [];
    // Approximate: distribute total words across spans in proportion to duration.
    const bounds = [0, ...this._pauseBoundaries, this.audioMs];
    const totalWords = tokenize(this._fullText()).length;
    const totalDur = this.audioMs || 1;
    return bounds.slice(1).map((b, i) => {
      const dur = b - bounds[i];
      return (totalWords * dur) / totalDur;
    });
  }

  _answerLatency() {
    const q = this.questionMarks[this.questionMarks.length - 1];
    if (!q) return null;
    // Was the speaker already talking when the question was marked?
    const openAtMark =
      this._vad.state === 'speech' && this._vad.openSince <= q.t;
    const priorSpeech = this._speech.some((s) => s.start <= q.t && s.end >= q.t);
    if (openAtMark || priorSpeech) return { pending: false, alreadySpeaking: true };

    const onset = [...this._speech, this._vad.state === 'speech' ? { start: this._vad.openSince, end: this.audioMs } : null]
      .filter(Boolean)
      .filter((s) => s.start >= q.t && s.end - s.start >= 300)
      .sort((a, b) => a.start - b.start)[0];
    if (!onset) return { pending: true, sinceMs: this.now() - q.t };
    return { pending: false, latencyMs: Math.round(onset.start - q.t) };
  }

  energyTimeline(maxPoints = 220) {
    const slice = this._vizFrames.slice(-maxPoints);
    const peak = Math.max(0.02, ...slice.map((f) => f.energy));
    return slice.map((f) => ({ t: f.t, v: Math.min(1, f.energy / peak) }));
  }

  // --- snapshot ---------------------------------------------------------

  snapshot() {
    const elapsed = this.now();
    const from = Math.max(0, elapsed - PACE_WINDOW_MS);

    const allText = this._fullText();
    const allTokens = tokenize(allText);

    const speakS = this._speakingSecondsInWindow(from, elapsed);
    const speakTotalS = this._speakingSecondsTotal();
    const windowWords = this._windowedWordCount(from, elapsed);

    let wpm = null;
    if (windowWords >= MIN_PACE_WORDS && speakS >= MIN_PACE_SPEAKING_S) {
      const raw = paceWpm(windowWords, speakS);
      this._paceEma = this._paceEma == null ? raw : PACE_EMA * raw + (1 - PACE_EMA) * this._paceEma;
      wpm = Math.round(this._paceEma);
    }
    const paceDescriptor = wpm == null ? null : wpm > 185 ? 'fast' : wpm < 115 ? 'measured' : 'steady';
    if (paceDescriptor && paceDescriptor !== this._lastPaceKind && paceDescriptor !== 'steady') {
      this.timeline.push({ t: elapsed, kind: `pace-${paceDescriptor}`, meta: { wpm } });
    }
    if (paceDescriptor) this._lastPaceKind = paceDescriptor;

    const fillers = countFillers(allText);
    const unit = meanUnitLength(allText, this._pauseSpanWordCounts());

    const pauses = this.timeline.filter((e) => e.kind === 'pause' || e.kind === 'long-pause');
    const pauseDur = pauses.map((e) => e.meta.durationMs);

    const enoughForFillers = speakTotalS >= MIN_FILLER_SPEAKING_S;

    return {
      elapsedMs: elapsed,
      transcript: {
        text: allText,
        wordCount: allTokens.length,
        source: this._transcriptSource,
      },
      pace: {
        wpm,
        descriptor: paceDescriptor,
        window: 'last 30s of speaking time',
        ready: wpm != null,
      },
      pauses: {
        count: pauses.length,
        meanMs: pauseDur.length ? Math.round(pauseDur.reduce((a, b) => a + b, 0) / pauseDur.length) : null,
        longestMs: pauseDur.length ? Math.max(...pauseDur) : null,
      },
      fillers: {
        ready: enoughForFillers,
        hardPerMin: enoughForFillers ? rate(fillers.hard.count, speakTotalS) : null,
        softPerMin: enoughForFillers ? rate(fillers.soft.count, speakTotalS) : null,
        hardExamples: [...new Set(fillers.hard.tokens)].slice(0, 6),
        softExamples: [...new Set(fillers.soft.tokens)].slice(0, 6),
        note: 'Some transcribers drop “um/uh”; treat hard-filler counts as a floor.',
      },
      vocabulary: {
        variety: round(mattr(allTokens, 50)),
        varietyBasis: 'MATTR-50',
        longWordRate: round(longWordRate(allTokens)),
        distinctWords: new Set(allTokens).size,
        meanUnitLength: round(unit.value, 1),
        meanUnitBasis: unit.basis,
      },
      delivery: {
        talkRatio: elapsed > 0 ? round(Math.min(1, speakTotalS / (elapsed / 1000))) : 0,
        speakingSecondsTotal: Math.round(speakTotalS),
      },
      answerLatency: this._answerLatency(),
      timeline: this.timeline.slice(-80),
    };
  }

  export() {
    return {
      durationMs: this.now(),
      transcriptSource: this._transcriptSource,
      transcript: this.transcript,
      questionMarks: this.questionMarks,
      timeline: this.timeline,
      finalSnapshot: this.snapshot(),
    };
  }
}

function round(x, places = 2) {
  if (x == null || Number.isNaN(x)) return null;
  const f = 10 ** places;
  return Math.round(x * f) / f;
}
function rate(count, seconds) {
  if (!seconds || seconds <= 0) return 0;
  return Math.round((count / seconds) * 60 * 10) / 10;
}
