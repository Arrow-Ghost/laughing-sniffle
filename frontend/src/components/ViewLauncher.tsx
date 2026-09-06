import { useEffect, useMemo, useState } from 'react';
import { API_BASE } from '@/lib/api';

type Accent = 'cyan' | 'mint' | 'amber';

interface RecentSession {
  id: string;
  label: string;
  mode: string;
  status: 'live' | 'ended';
  createdAt: number;
  endedAt: number | null;
  eventId: string | null;
  languages?: string[];
}

const MODE_LABEL: Record<string, string> = {
  'debate-practice': 'Debate practice',
  'interview-prep': 'Interview prep',
  'speech-coaching': 'Speech coaching',
};

const ACCENT: Record<Accent, { text: string; ring: string; dot: string; glow: string; chip: string }> = {
  cyan: {
    text: 'text-cyan',
    ring: 'hover:border-cyan/40 hover:shadow-[0_0_0_1px_rgba(0,212,255,0.25),0_18px_60px_-20px_rgba(0,212,255,0.35)]',
    dot: 'bg-cyan',
    glow: 'from-cyan/25',
    chip: 'border-cyan/40 bg-cyan/10 text-cyan',
  },
  mint: {
    text: 'text-mint',
    ring: 'hover:border-mint/40 hover:shadow-[0_0_0_1px_rgba(0,255,156,0.25),0_18px_60px_-20px_rgba(0,255,156,0.35)]',
    dot: 'bg-mint',
    glow: 'from-mint/25',
    chip: 'border-mint/40 bg-mint/10 text-mint',
  },
  amber: {
    text: 'text-amber',
    ring: 'hover:border-amber/40 hover:shadow-[0_0_0_1px_rgba(255,184,0,0.25),0_18px_60px_-20px_rgba(255,184,0,0.35)]',
    dot: 'bg-amber',
    glow: 'from-amber/25',
    chip: 'border-amber/40 bg-amber/10 text-amber',
  },
};

function ago(ms: number): string {
  const s = Math.max(0, Date.now() - ms) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export default function ViewLauncher({
  kind,
  eyebrow,
  title,
  blurb,
  accent = 'cyan',
  paramName = 'session',
  extraParams = [],
}: {
  kind: string;
  eyebrow: string;
  title: string;
  blurb: string;
  accent?: Accent;
  paramName?: string;
  extraParams?: Array<{ name: string; label: string; hint: string }>;
}) {
  const a = ACCENT[accent];
  const [sessions, setSessions] = useState<RecentSession[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manual, setManual] = useState('');

  useEffect(() => {
    let alive = true;
    fetch(`${API_BASE}/api/sessions?limit=24`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`${r.status}`))))
      .then((rows: RecentSession[]) => alive && setSessions(rows))
      .catch((e) => alive && setErr(String(e.message ?? e)));
    return () => {
      alive = false;
    };
  }, []);

  const go = (id: string, param = paramName) => {
    if (!id.trim()) return;
    window.location.href = `/${kind}?${param}=${encodeURIComponent(id.trim())}`;
  };

  const grouped = useMemo(() => {
    if (!sessions) return { live: [], ended: [] };
    return {
      live: sessions.filter((s) => s.status === 'live'),
      ended: sessions.filter((s) => s.status === 'ended'),
    };
  }, [sessions]);

  return (
    <div className="relative mx-auto max-w-4xl px-4 py-14 sm:py-20">
      {/* ambient glow */}
      <div
        aria-hidden
        className={`pointer-events-none absolute -top-24 left-1/2 h-72 w-[42rem] -translate-x-1/2 rounded-full bg-gradient-to-b ${a.glow} to-transparent blur-3xl opacity-60`}
      />

      <div className="relative">
        <p className={`text-[11px] font-medium uppercase tracking-[0.22em] ${a.text}`}>{eyebrow}</p>
        <h1 className="mt-3 text-balance text-3xl font-bold leading-[1.1] sm:text-4xl">{title}</h1>
        <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-white/55">{blurb}</p>
      </div>

      {/* open by id */}
      <div className="glass mt-9 p-5">
        <label className="metric-label">Open a session</label>
        <div className="mt-2 flex flex-col gap-2 sm:flex-row">
          <input
            value={manual}
            onChange={(e) => setManual(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && go(manual)}
            placeholder="Paste a session ID…"
            className="flex-1 rounded-xl border border-stroke bg-black/25 px-3.5 py-2.5 font-mono text-sm outline-none transition focus:border-white/30 focus:bg-black/40"
          />
          <button className={`btn ${manual.trim() ? 'btn-primary' : ''}`} disabled={!manual.trim()} onClick={() => go(manual)}>
            Open →
          </button>
        </div>
        {extraParams.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12px] text-white/40">
            {extraParams.map((p) => (
              <span key={p.name}>
                or <code className="text-white/70">/{kind}?{p.name}=&lt;id&gt;</code> — {p.hint}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* recent sessions */}
      <div className="mt-8">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold text-white/80">Recent sessions</h2>
          <a href="/console" className={`text-xs ${a.text} hover:underline`}>
            Start a new one →
          </a>
        </div>

        {err && (
          <div className="glass p-5 text-sm text-white/50">
            Couldn’t reach the backend ({err}). Start it with <code className="text-white/75">npm run dev</code>, then reload.
          </div>
        )}

        {!err && sessions === null && (
          <div className="grid gap-2.5 sm:grid-cols-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="glass h-[68px] animate-pulse opacity-40" />
            ))}
          </div>
        )}

        {!err && sessions?.length === 0 && (
          <div className="glass p-6 text-sm text-white/50">
            No sessions recorded yet. Open the <a href="/console" className={a.text}>console</a> and run one — it’ll show up
            here.
          </div>
        )}

        {!err && sessions && sessions.length > 0 && (
          <div className="space-y-5">
            {grouped.live.length > 0 && (
              <div>
                <p className="metric-label mb-2 flex items-center gap-1.5">
                  <span className={`inline-block h-1.5 w-1.5 animate-pulse rounded-full ${a.dot}`} /> Live
                </p>
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {grouped.live.map((s) => (
                    <SessionCard key={s.id} s={s} accent={a} onOpen={() => go(s.id)} />
                  ))}
                </div>
              </div>
            )}
            {grouped.ended.length > 0 && (
              <div>
                {grouped.live.length > 0 && <p className="metric-label mb-2">Ended</p>}
                <div className="grid gap-2.5 sm:grid-cols-2">
                  {grouped.ended.map((s) => (
                    <SessionCard key={s.id} s={s} accent={a} onOpen={() => go(s.id)} />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SessionCard({
  s,
  accent,
  onOpen,
}: {
  s: RecentSession;
  accent: (typeof ACCENT)[Accent];
  onOpen: () => void;
}) {
  return (
    <button
      onClick={onOpen}
      className={`glass group flex w-full flex-col items-start gap-1 p-4 text-left transition duration-200 ease-pop hover:-translate-y-0.5 ${accent.ring}`}
    >
      <div className="flex w-full items-center justify-between gap-2">
        <span className="truncate font-medium text-white/90">{s.label || 'Untitled session'}</span>
        <span
          className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase tracking-wide ${
            s.status === 'live' ? accent.chip : 'border-white/12 text-white/40'
          }`}
        >
          {s.status}
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[11px] text-white/40">
        <span>{MODE_LABEL[s.mode] ?? s.mode}</span>
        <span className="text-white/20">·</span>
        <span>{ago(s.createdAt)}</span>
        {s.languages && s.languages.length > 0 && (
          <>
            <span className="text-white/20">·</span>
            <span>{s.languages.join(', ')}</span>
          </>
        )}
      </div>
      <span className="mt-1 font-mono text-[10px] text-white/25 transition group-hover:text-white/40">{s.id}</span>
    </button>
  );
}
