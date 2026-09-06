import { useEffect, useState } from 'react';
import { getLanguage, type LanguageProfile } from '@/lib/judgeApi';

/** One-line, descriptive language summary for a session (spec §12, §13). */
export default function LanguageLine({ sessionId }: { sessionId: string }) {
  const [p, setP] = useState<LanguageProfile | null>(null);
  useEffect(() => {
    getLanguage(sessionId)
      .then(setP)
      .catch(() => setP(null));
  }, [sessionId]);

  if (!p || p.primary === 'und' || (p.languages.length <= 1 && !p.codeSwitching)) return null;

  const langs = p.languages.map((l) => `${l.lang} ${Math.round(l.share * 100)}%`).join(' · ');
  return (
    <p className="mt-2 text-xs text-white/50">
      <span className="text-white/70">Delivered in {p.primary}</span>
      {p.languages.length > 1 && ` (${langs})`}
      {p.codeSwitching && ` · code-switching, ${p.switches} transitions`}
      {p.outsidePolicy.length > 0 && (
        <span className="text-amber/80"> · {p.outsidePolicy.join(', ')} not in the event’s listed languages (a note for the judge, not a penalty)</span>
      )}
    </p>
  );
}
