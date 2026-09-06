// Pure, side-effect-free helpers for descriptive speech metrics.
// Nothing here scores a person or estimates authorship — these are the same
// kinds of numbers a speech coach jots on a notepad.

// Unambiguous hesitation sounds. Transcribers vary in whether they keep these,
// so the headline filler metric is reported with that caveat in the UI.
const HARD_FILLER = /\b(?:u+h+|u+m+|e+r+m*|hm+|mm+|mhm)\b/gi;

// Discourse markers that are *sometimes* fillers. Counted conservatively and
// reported separately from hard fillers.
const SOFT_FILLER_PHRASES = [
  /\byou know\b/gi,
  /\bi mean\b/gi,
  /\bsort of\b/gi,
  /\bkind of\b/gi,
  /\bi guess\b/gi,
];

// Words that, immediately before "like", make it a real word rather than a filler.
const LIKE_NOT_FILLER_PREV = new Set([
  'would', 'wouldnt', 'could', 'couldnt', 'should', 'shouldnt', 'do', 'dont',
  'does', 'doesnt', 'did', 'didnt', 'to', 'feel', 'feels', 'felt', 'look',
  'looks', 'looked', 'looking', 'seem', 'seems', 'seemed', 'sound', 'sounds',
  'sounded', 'just', 'not', 'really', 'much', 'things', 'something', 'anything',
  'nothing', 'stuff', 'people', 'someone', 'act', 'acts', 'acted', 'acting',
  'more', 'is', 'was', 'be', 'been',
]);

const FUNCTION_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'if', 'of', 'to', 'in', 'on', 'at',
  'for', 'with', 'as', 'by', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'am', 'do', 'does', 'did', 'have', 'has', 'had', 'i', 'you', 'he', 'she',
  'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them', 'my', 'your', 'his',
  'its', 'our', 'their', 'this', 'that', 'these', 'those', 'so', 'not', 'no',
  'yes', 'up', 'out', 'about', 'into', 'over', 'than', 'then', 'from', 'will',
  'would', 'can', 'could', 'should', 'may', 'might', 'must', 'shall', 'there',
  'here', 'what', 'which', 'who', 'when', 'where', 'why', 'how', 'all', 'any',
  'some', 'more', 'most', 'other', 'such', 'only', 'own', 'same', 'just', 'very',
]);

/** Root-mean-square amplitude of a Float32 sample block, range 0..~1. */
export function rms(samples) {
  if (!samples || samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

/** Lowercase word tokens, punctuation stripped (apostrophes/hyphens kept). */
export function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s'-]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** Rough English syllable count for a single word (vowel-group heuristic). */
export function syllables(word) {
  const w = (word || '').toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return w.length ? 1 : 0;
  const groups = w
    .replace(/e\b/, '')
    .replace(/[^aeiouy]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return Math.max(1, groups.length);
}

/**
 * Moving-Average Type-Token Ratio: mean TTR over every window of `w` tokens.
 * Unlike a plain TTR it is not biased downward as the transcript grows, so it
 * is a fairer description of lexical variety over a whole session.
 */
export function mattr(tokens, w = 50) {
  if (tokens.length === 0) return null;
  if (tokens.length <= w) return new Set(tokens).size / tokens.length;
  let acc = 0;
  let n = 0;
  for (let i = 0; i + w <= tokens.length; i += 1) {
    acc += new Set(tokens.slice(i, i + w)).size / w;
    n += 1;
  }
  return acc / n;
}

/** Share of content words with 3+ syllables — a "reach for longer words" rate. */
export function longWordRate(tokens) {
  const content = tokens.filter((t) => !FUNCTION_WORDS.has(t));
  if (content.length < 8) return null;
  const long = content.filter((t) => syllables(t) >= 3).length;
  return long / content.length;
}

/**
 * Count hard fillers and (separately, conservatively) soft/discourse fillers.
 * `text` should be a transcript string; token context is used to gate "like".
 */
export function countFillers(text) {
  const src = text || '';
  const hard = (src.match(HARD_FILLER) || []).map((s) => s.toLowerCase());

  const soft = [];
  for (const re of SOFT_FILLER_PHRASES) {
    re.lastIndex = 0;
    const m = src.match(re) || [];
    soft.push(...m.map((s) => s.toLowerCase().replace(/\s+/g, ' ')));
  }

  // "like" as filler: quotative ("I was like"), comma-bracketed, or clause-initial
  // — but not when the preceding word makes it lexical ("feel like", "things like").
  const toks = tokenize(src);
  const commaLike = (src.match(/,\s*like\b/gi) || []).length;
  let quotativeLike = 0;
  for (let i = 1; i < toks.length; i += 1) {
    if (toks[i] !== 'like') continue;
    const prev = toks[i - 1].replace(/'/g, '');
    if (LIKE_NOT_FILLER_PREV.has(prev)) continue;
    if (/^(?:i|he|she|they|we|you|im|hes|shes|theyre|were|youre|was|is)$/.test(prev)) {
      quotativeLike += 1;
    }
  }
  const likeFiller = Math.min(
    toks.filter((t) => t === 'like').length,
    commaLike + quotativeLike,
  );
  for (let i = 0; i < likeFiller; i += 1) soft.push('like');

  return {
    hard: { count: hard.length, tokens: hard },
    soft: { count: soft.length, tokens: soft },
  };
}

/** How much terminal punctuation the transcript carries, per word. */
export function punctuationDensity(text) {
  const words = tokenize(text).length;
  if (words === 0) return 0;
  return ((text || '').match(/[.!?]/g) || []).length / words;
}

/**
 * Mean words per unit. If the transcript is punctuated, units are sentences.
 * Otherwise (common with live speech-to-text) units are the spans between
 * pauses, passed in as `pauseSpansWords`. Returns { value, basis }.
 */
export function meanUnitLength(text, pauseSpansWords) {
  if (punctuationDensity(text) >= 0.02) {
    const sentences = (text || '')
      .split(/[.!?]+/)
      .map((s) => tokenize(s).length)
      .filter((n) => n > 0);
    if (sentences.length === 0) return { value: null, basis: 'punctuation' };
    return {
      value: sentences.reduce((a, b) => a + b, 0) / sentences.length,
      basis: 'punctuation',
    };
  }
  if (Array.isArray(pauseSpansWords) && pauseSpansWords.length >= 2) {
    const spans = pauseSpansWords.filter((n) => n > 0);
    if (spans.length === 0) return { value: null, basis: 'pauses' };
    return { value: spans.reduce((a, b) => a + b, 0) / spans.length, basis: 'pauses' };
  }
  return { value: null, basis: 'pauses' };
}

/** Words per minute normalised by *speaking* time, not wall-clock time. */
export function paceWpm(wordCount, speakingSeconds) {
  if (!speakingSeconds || speakingSeconds <= 0) return null;
  return (wordCount / speakingSeconds) * 60;
}

/** p-th percentile (0..1) of an unsorted numeric array. */
export function percentile(arr, p) {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * s.length)))];
}

/**
 * Streaming voice-activity detector. Feed it one energy sample at a time.
 *
 * The noise floor is the low percentile of a rolling window of recent energy, so
 * it tracks both a quiet room and a hot mic instead of an absolute guess. On/off
 * thresholds differ (hysteresis) and a ~0.55s hangover keeps ordinary gaps
 * between words from chopping a phrase into dozens of "pauses". Finalised
 * speech/silence segments are returned as they close.
 */
export function createVad({
  windowFrames = 160, // rolling window for the floor estimate
  floorPercentile = 0.2,
  onFactor = 2.6,
  offFactor = 1.7,
  onAbs = 0.006,
  offAbs = 0.004,
  onMs = 180, // sustained over-threshold audio needed to open speech
  hangoverMs = 550, // sustained quiet needed to close speech (survives inter-word gaps)
} = {}) {
  const recent = [];
  let floor = 0.006; // seeded low so a hot start still detects speech
  let state = 'silence';
  let segStart = 0;
  let onAccum = 0;
  let offAccum = 0;
  let sawSpeech = false;

  return {
    /** @returns {null | {kind, start, end}} a finalised segment, when one closes */
    push(energy, tStart, tEnd) {
      const dur = tEnd - tStart;
      recent.push(energy);
      if (recent.length > windowFrames) recent.shift();
      // Track the floor only while not mid-phrase (so speech can't inflate it).
      // It drops instantly to a quieter environment but rises slowly, which also
      // means a session that starts mid-speech isn't locked out.
      if (state === 'silence' || recent.length < 8) {
        const candidate = Math.max(1e-5, percentile(recent, floorPercentile));
        floor = candidate < floor ? candidate : floor * 0.98 + candidate * 0.02;
      }
      const onT = Math.max(floor * onFactor, onAbs);
      const offT = Math.max(floor * offFactor, offAbs);
      let closed = null;

      if (state === 'silence') {
        onAccum = energy > onT ? onAccum + dur : 0;
        if (onAccum >= onMs) {
          const boundary = tEnd - onAccum; // speech actually began onMs ago
          if (boundary > segStart) closed = { kind: 'silence', start: segStart, end: boundary };
          state = 'speech';
          segStart = boundary;
          onAccum = 0;
          sawSpeech = true;
        }
      } else {
        offAccum = energy < offT ? offAccum + dur : 0;
        if (offAccum >= hangoverMs) {
          const end = tEnd - offAccum; // trim the trailing quiet used to confirm
          closed = { kind: 'speech', start: segStart, end: Math.max(end, segStart + dur) };
          state = 'silence';
          segStart = end;
          offAccum = 0;
        }
      }
      return closed;
    },
    get state() {
      return state;
    },
    get openSince() {
      return segStart;
    },
    get sawSpeech() {
      return sawSpeech;
    },
    get noiseFloor() {
      return floor;
    },
  };
}

/** Fraction of [aStart,aEnd] that lies inside [bStart,bEnd], 0..1. */
export function overlapFraction(aStart, aEnd, bStart, bEnd) {
  const span = aEnd - aStart;
  if (span <= 0) return 0;
  const lo = Math.max(aStart, bStart);
  const hi = Math.min(aEnd, bEnd);
  return hi > lo ? (hi - lo) / span : 0;
}
