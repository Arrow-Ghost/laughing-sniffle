// Deterministic text primitives for the Integrity Engine (spec §29-33). No AI
// here — segmentation, shingling, similarity, common-phrase filtering,
// distinctive-phrase extraction, quotation/attribution detection. Gemini is only
// reached later, and only for high-value ambiguous pairs (spec §31).

const STOPWORDS = new Set(
  ('a an the and or but if of to in on at for with as by is are was were be been being am do does did ' +
    'have has had i you he she it we they me him her us them my your his its our their this that these ' +
    'those so not no yes up out about into over than then from will would can could should may might must ' +
    'shall there here what which who when where why how all any some more most other such only own same ' +
    'just very also too much many well get got go going make made say said think know like want need').split(
    ' ',
  ),
);

// Generic phrasing that carries little identifying information (spec §30).
// Anchored to the sentence start on purpose — a substantive sentence that merely
// contains "on balance" or "we should" partway through is NOT boilerplate.
const COMMON_PHRASE_PATTERNS: RegExp[] = [
  /^\W*(so|now|today|okay|right|well|first(ly| of all)?|second(ly)?|final(ly)?|next|moving on|thanks?|thank you|good (morning|afternoon|evening)|to (begin|start)( with)?|in (conclusion|summary)|on balance|in my (view|opinion)|let me (start|begin)|as i (said|mentioned))\b/i,
  /^\W*i (would like to|want to|am going to|'?ll|will|am here to) (talk about|discuss|argue|say|address|begin|start|explain|make the case|cover)\b/i,
  /^\W*the (core|main|key|central|fundamental|real|first|second|third)?\s*(issue|question|point|problem|argument|thing) (here )?is\b/i,
  /^\W*there are (two|three|several|many|a number of|multiple) (reasons|points|arguments|things)\b/i,
  /^\W*(it is|it's) (important|clear|obvious|worth noting) (that|to note)\b/i,
];

const ATTRIBUTION_CUES =
  /\b(according to|per |cites?|citing|as (stated|noted|written|argued|reported|shown) (by|in)|" ?\w|said (that )?|writes|argues that|reports that|as \w+ (said|noted|put it|argued|wrote)|study (by|from)|report (by|from)|research (by|from))\b/i;

export function normalize(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function words(text: string): string[] {
  return normalize(text).split(' ').filter(Boolean);
}

export function sentences(text: string): string[] {
  return (text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z"'(])|(?<=[.!?])$/)
    .map((s) => s.trim())
    .filter((s) => words(s).length >= 3);
}

/** Word k-gram (shingle) set of a text. */
export function shingles(text: string, k = 3): Set<string> {
  const w = words(text);
  const out = new Set<string>();
  if (w.length < k) {
    if (w.length) out.add(w.join(' '));
    return out;
  }
  for (let i = 0; i + k <= w.length; i += 1) out.add(w.slice(i, i + k).join(' '));
  return out;
}

/** Fraction of `a` contained in `b`: |a ∩ b| / |a|. Asymmetric on purpose —
 *  "how much of this phrase appears in that source". */
export function containment(a: Set<string>, b: Set<string>): number {
  if (a.size === 0) return 0;
  let hit = 0;
  for (const s of a) if (b.has(s)) hit += 1;
  return hit / a.size;
}

export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  return inter / (a.size + b.size - inter);
}

export function isCommonPhrase(sentence: string): boolean {
  const s = sentence.trim();
  if (COMMON_PHRASE_PATTERNS.some((re) => re.test(s))) return true;
  const w = words(s);
  const content = w.filter((x) => !STOPWORDS.has(x));
  const contentRatio = content.length / Math.max(1, w.length);
  // Very little substance regardless of length, or a short sentence that is
  // mostly connective tissue. Long sentences naturally carry more connectives,
  // so don't punish them for it.
  if (contentRatio < 0.22) return true;
  if (w.length <= 12 && contentRatio < 0.38) return true;
  return new Set(content).size < 3;
}

/**
 * A rough "how rare / identifying is this phrasing" score, 0..1. High = a
 * distinctive turn of phrase worth checking against sources (spec §30).
 */
export function phraseUniqueness(phrase: string): number {
  const w = words(phrase);
  if (w.length < 4) return 0;
  const content = w.filter((x) => !STOPWORDS.has(x));
  if (content.length < 3) return content.length ? 0.1 : 0;
  const contentRatio = content.length / w.length;
  const distinctContent = new Set(content).size / Math.max(1, content.length);
  const lengthScore = Math.min(1, w.length / 18);
  const longWords = content.filter((x) => x.length >= 8).length / Math.max(1, content.length);
  return clamp01(0.35 * contentRatio + 0.25 * distinctContent + 0.2 * lengthScore + 0.2 * longWords);
}

export interface DistinctivePhrase {
  text: string;
  index: number; // sentence index within the transcript
  uniqueness: number;
}

/** Pick the high-information sentences to search for (spec §29). */
export function distinctivePhrases(
  text: string,
  { limit = 12, minUniqueness = 0.4 }: { limit?: number; minUniqueness?: number } = {},
): DistinctivePhrase[] {
  const out: DistinctivePhrase[] = [];
  sentences(text).forEach((s, index) => {
    if (isCommonPhrase(s)) return;
    const uniqueness = phraseUniqueness(s);
    if (uniqueness < minUniqueness) return;
    out.push({ text: s, index, uniqueness });
  });
  return out.sort((a, b) => b.uniqueness - a.uniqueness).slice(0, limit);
}

/** Is `phrase` attributed to a source, or presented as a direct quote? */
export function isAttributed(fullText: string, phrase: string): boolean {
  const idx = fullText.toLowerCase().indexOf(phrase.toLowerCase().slice(0, 40));
  const windowText = idx >= 0 ? fullText.slice(Math.max(0, idx - 160), idx + phrase.length + 40) : phrase;
  if (ATTRIBUTION_CUES.test(windowText)) return true;
  // inside quotation marks
  return /["“”].{0,400}["“”]/s.test(windowText) && /["“”]/.test(fullText.slice(Math.max(0, idx - 3), idx + 3));
}

export function classifyQuotation(
  similarity: number,
  attributed: boolean,
  uniqueness: number,
): 'original' | 'copied' | 'quoted' | 'paraphrased' | 'common-knowledge' | 'attributed' | 'uncertain' {
  if (uniqueness < 0.35) return 'common-knowledge';
  if (attributed && similarity >= 0.6) return 'quoted';
  if (attributed) return 'attributed';
  if (similarity >= 0.8) return 'copied';
  if (similarity >= 0.45) return 'paraphrased';
  if (similarity >= 0.25) return 'uncertain';
  return 'original';
}

export function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}
