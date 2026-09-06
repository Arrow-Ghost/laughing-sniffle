// Language profile + code-switch detection (spec §12, §13). Pure — works off the
// per-segment `lang` that multilingual transcription puts on TranscriptSegment.
// Code-switching is DESCRIBED here, never scored; policy decides if it matters.

import type { LanguageProfile, LanguageSpan, TranscriptSegment } from '../domain/types.ts';

function base(lang: string | null | undefined): string {
  return (lang ?? 'und').split('-')[0]!.toLowerCase() || 'und';
}

/** Merge consecutive same-language segments into contiguous spans. */
export function languageSpans(segments: TranscriptSegment[]): LanguageSpan[] {
  const finals = segments.filter((s) => s.isFinal && s.text.trim()).sort((a, b) => a.t0 - b.t0);
  const spans: LanguageSpan[] = [];
  for (const s of finals) {
    const lang = base(s.lang);
    const last = spans[spans.length - 1];
    if (last && last.lang === lang) {
      last.end = s.t1;
      last.text += ` ${s.text.trim()}`;
    } else {
      spans.push({ start: s.t0, end: s.t1, lang, text: s.text.trim() });
    }
  }
  return spans;
}

export function languageProfile(
  segments: TranscriptSegment[],
  policyLanguages: string[] = [],
): LanguageProfile {
  const spans = languageSpans(segments);
  if (spans.length === 0) {
    return { primary: 'und', languages: [], switches: 0, codeSwitching: false, outsidePolicy: [] };
  }

  const byLang = new Map<string, { ms: number; spans: number }>();
  for (const sp of spans) {
    const cur = byLang.get(sp.lang) ?? { ms: 0, spans: 0 };
    cur.ms += Math.max(0, sp.end - sp.start);
    cur.spans += 1;
    byLang.set(sp.lang, cur);
  }
  const totalMs = [...byLang.values()].reduce((a, v) => a + v.ms, 0) || 1;
  const languages = [...byLang.entries()]
    .map(([lang, v]) => ({ lang, share: Math.round((v.ms / totalMs) * 100) / 100, spans: v.spans }))
    .sort((a, b) => b.share - a.share);

  const switches = spans.slice(1).filter((sp, i) => sp.lang !== spans[i]!.lang).length;
  const allowed = new Set(policyLanguages.map(base).filter((l) => l !== 'und'));
  const outsidePolicy =
    allowed.size === 0 ? [] : languages.map((l) => l.lang).filter((l) => l !== 'und' && !allowed.has(l));

  return {
    primary: languages[0]!.lang,
    languages,
    switches,
    codeSwitching: languages.filter((l) => l.lang !== 'und' && l.share >= 0.1).length >= 2,
    outsidePolicy,
  };
}
