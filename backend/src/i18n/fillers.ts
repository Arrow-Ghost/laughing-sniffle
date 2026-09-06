// Language-aware filler lexicons (spec §9). The English set stays in speech-core
// (metrics.js); this is the multilingual extension used when a non-English
// primary language is detected. Small on purpose — "hard" hesitation sounds
// only, which are the defensible ones.

const HARD: Record<string, RegExp> = {
  en: /\b(?:u+h+|u+m+|e+r+m*|hm+|mm+)\b/gi,
  hi: /\b(?:matlab|yaar|haan|arre|toh|aa+|uh+|um+)\b/gi, // Hinglish hesitation markers
  es: /\b(?:e+h+|este|o sea|pues|bueno|em+)\b/gi,
  fr: /\b(?:e+u+h+|ben|bah|hein|donc)\b/gi,
  de: /\b(?:ä+h+m*|öh+|halt|also|ja)\b/gi,
  pt: /\b(?:é+|tipo|então|né|hum+)\b/gi,
};

/** Count hard fillers in `text` for the given BCP-47 language (falls back to en). */
export function countHardFillers(text: string, lang: string | null): { count: number; tokens: string[] } {
  const base = (lang ?? 'en').split('-')[0]!.toLowerCase();
  const re = HARD[base] ?? HARD.en!;
  re.lastIndex = 0;
  const m = (text || '').match(re) ?? [];
  return { count: m.length, tokens: m.map((s) => s.toLowerCase()) };
}

export function fillerLexiconAvailable(lang: string | null): boolean {
  const base = (lang ?? 'en').split('-')[0]!.toLowerCase();
  return Boolean(HARD[base]);
}
