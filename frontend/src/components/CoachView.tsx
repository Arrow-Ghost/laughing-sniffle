import { useEffect, useMemo, useState } from 'react';
import ViewLauncher from './ViewLauncher';
import {
  buildPlan,
  clock,
  compare,
  gradeDrill,
  getPlan,
  getProgress,
  listPlans,
  opponentTurn,
  PERSONAS,
  startDrill,
  type BeforeAfter,
  type CoachPersona,
  type CoachPlan,
  type Drill,
  type Progress,
} from '@/lib/coachApi';

function q(key: string) {
  return useMemo(() => (typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get(key)), [key]);
}

function DrillCard({ drill: initial }: { drill: Drill }) {
  const [drill, setDrill] = useState(initial);
  const [arg, setArg] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  return (
    <div className="rounded-lg border border-cyan/20 bg-cyan/[0.03] p-4">
      <div className="flex items-center justify-between text-xs">
        <span className="font-mono text-cyan">
          {drill.type} · {drill.difficulty} · {drill.timeLimitSec}s
        </span>
        <span className="text-white/40">{drill.status}</span>
      </div>
      <p className="mt-2 text-sm text-white/85">{drill.prompt}</p>
      <p className="mt-1 text-[11px] text-white/40">Targets: “{drill.fromWeakness}”</p>

      {drill.exchanges.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-white/5 pt-2 text-xs">
          {drill.exchanges.map((e, i) => (
            <p key={i} className={e.role === 'opponent' ? 'text-amber/90' : 'text-white/70'}>
              <span className="text-white/35">{e.role === 'opponent' ? 'Opponent' : 'You'}:</span> {e.text}
            </p>
          ))}
        </div>
      )}

      {drill.grade ? (
        <div className="mt-3 rounded border border-mint/20 bg-mint/5 p-2 text-xs">
          <span className="text-mint">
            {drill.grade.score}/{drill.grade.scaleMax} · {drill.grade.targetMet ? 'target met' : 'not yet'} · next: {drill.grade.suggestedNextDifficulty}
          </span>
          <p className="mt-1 text-white/70">{drill.grade.feedback}</p>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-1.5">
          <input
            className="min-w-[12rem] flex-1 rounded border border-stroke bg-black/30 px-2 py-1 text-xs outline-none"
            placeholder="type an argument to test against the AI opponent"
            value={arg}
            onChange={(e) => setArg(e.target.value)}
          />
          <button
            className="btn !px-2 !py-1 text-[11px]"
            disabled={busy !== null || !arg.trim()}
            onClick={async () => {
              setBusy('opp');
              setErr(null);
              try {
                setDrill(await opponentTurn(drill.id, arg));
                setArg('');
              } catch (e: any) {
                setErr(e.message);
              } finally {
                setBusy(null);
              }
            }}
          >
            {busy === 'opp' ? '…' : 'opponent turn'}
          </button>
          {drill.responseSessionId && (
            <button
              className="btn btn-primary !px-2 !py-1 text-[11px]"
              disabled={busy !== null}
              onClick={async () => {
                setBusy('grade');
                setErr(null);
                try {
                  setDrill(await gradeDrill(drill.id));
                } catch (e: any) {
                  setErr(e.message);
                } finally {
                  setBusy(null);
                }
              }}
            >
              grade the recorded attempt
            </button>
          )}
        </div>
      )}
      {!drill.responseSessionId && !drill.grade && (
        <p className="mt-1.5 text-[11px] text-white/35">
          To grade this drill, record an answer to the prompt in the console, then attach it via{' '}
          <code>POST /api/drills/{drill.id}/response</code>.
        </p>
      )}
      {err && <p className="mt-1 text-xs text-rose">{err}</p>}
    </div>
  );
}

export default function CoachView() {
  const sessionId = q('session');
  const planIdParam = q('plan');

  const [plan, setPlan] = useState<CoachPlan | null>(null);
  const [persona, setPersona] = useState<CoachPersona>('supportive');
  const [progress, setProgress] = useState<Progress | null>(null);
  const [ba, setBa] = useState<BeforeAfter | null>(null);
  const [beforeId, setBeforeId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    setError(null);
    try {
      let p: CoachPlan | null = null;
      if (planIdParam) p = await getPlan(planIdParam);
      else if (sessionId) p = (await listPlans(sessionId))[0] ?? null;
      if (p && !p.drills) p = await getPlan(p.id);
      setPlan(p);
      if (p?.participantId) setProgress(await getProgress(p.participantId).catch(() => null));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoaded(true);
    }
  }
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, planIdParam]);

  async function build() {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const p = await buildPlan(sessionId, persona);
      setPlan(await getPlan(p.id));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function drill(i: number) {
    if (!plan) return;
    setBusy(true);
    try {
      await startDrill(plan.id, i);
      setPlan(await getPlan(plan.id));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!sessionId && !planIdParam) {
    return (
      <ViewLauncher
        kind="coach"
        accent="mint"
        eyebrow="Practice, grounded in the judge"
        title="Turn an evaluation into a training plan."
        blurb="Coaching quotes the judge’s exact weaknesses, maps each to a drill, and runs an AI opponent with memory. Pick a judged session to build a plan."
        extraParams={[{ name: 'plan', label: 'plan', hint: 'reopen a saved plan' }]}
      />
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <h1 className="text-lg font-semibold">Coaching</h1>
      <p className="mt-1 text-sm text-white/50">
        Built from the judge’s exact findings — the weaknesses below are quoted from the evaluation, not re-written.
      </p>
      {error && <div className="mt-3 rounded-xl border border-rose/40 bg-rose/10 px-4 py-2 text-sm text-rose">{error}</div>}

      {loaded && !plan && (
        <div className="glass mt-4 p-6">
          <p className="text-sm text-white/55">No coaching plan yet for this session.</p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select
              className="rounded-lg border border-stroke bg-black/30 px-3 py-1.5 text-sm outline-none"
              value={persona}
              onChange={(e) => setPersona(e.target.value as CoachPersona)}
            >
              {PERSONAS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
            <button className="btn btn-primary" disabled={busy} onClick={build}>
              {busy ? 'Building…' : 'Build coaching plan'}
            </button>
          </div>
        </div>
      )}

      {plan && (
        <>
          <header className="glass mt-4 p-5">
            <div className="flex flex-wrap items-baseline gap-3">
              <span className="font-mono text-2xl font-semibold">
                {plan.overallScore.toFixed(1)}
                <span className="text-sm text-white/40"> / {plan.scaleMax}</span>
              </span>
              <span className="text-[11px] text-white/45">persona: {plan.persona}</span>
              <span className="text-[11px] text-white/45">focus: {plan.focusAreas.join(', ')}</span>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-white/80">{plan.summary}</p>
            {plan.keepDoing.length > 0 && (
              <div className="mt-2">
                <div className="metric-label text-mint/70">Keep doing</div>
                <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-white/70">
                  {plan.keepDoing.map((k, i) => (
                    <li key={i}>{k}</li>
                  ))}
                </ul>
              </div>
            )}
          </header>

          <div className="mt-4 space-y-3">
            {plan.weaknesses.length === 0 && (
              <p className="glass p-5 text-sm text-white/55">The judge flagged no specific weaknesses. Keep drilling what already works.</p>
            )}
            {plan.weaknesses.map((w, i) => {
              const dr = (plan.drills ?? []).find((d) => d.fromWeakness === w.weaknessText);
              return (
                <div key={i} className="glass p-5">
                  <div className="flex items-baseline justify-between gap-2">
                    <h3 className="text-sm font-semibold text-white/90">
                      {w.criterionName} <span className="text-white/35">{w.score}/{plan.scaleMax}</span>
                    </h3>
                    {!dr && (
                      <button className="btn !px-3 !py-1 text-xs" disabled={busy} onClick={() => drill(i)}>
                        Start {w.suggestedDrill}
                      </button>
                    )}
                  </div>
                  <p className="mt-1.5 text-sm text-white/75">{w.weaknessText}</p>
                  {w.evidence.map((e, k) => (
                    <p key={k} className="mt-1 text-xs text-white/45">
                      <span className="font-mono">{clock(e.startMs)}–{clock(e.endMs)}</span> “{e.quote}”
                    </p>
                  ))}
                  {dr && (
                    <div className="mt-3">
                      <DrillCard drill={dr} />
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          <div className="glass mt-4 p-5">
            <div className="metric-label">Before / after — compare this round to an earlier session</div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                className="min-w-[16rem] flex-1 rounded-lg border border-stroke bg-black/30 px-3 py-1.5 text-sm outline-none"
                placeholder="earlier session id (the ‘before’)"
                value={beforeId}
                onChange={(e) => setBeforeId(e.target.value)}
              />
              <button
                className="btn !px-3 !py-1 text-xs"
                disabled={!beforeId.trim()}
                onClick={async () => {
                  try {
                    setBa(await compare(beforeId.trim(), plan.sessionId));
                  } catch (e: any) {
                    setError(e.message);
                  }
                }}
              >
                Compare
              </button>
            </div>
            {ba && (
              <div className="mt-3 grid gap-3 sm:grid-cols-2">
                <div>
                  <div className="metric-label">Criteria</div>
                  <ul className="mt-1 text-xs">
                    {ba.criteria.map((c, i) => (
                      <li key={i} className={dcls(c.delta)}>
                        {c.criterionName}: {fmt(c.before)} → {fmt(c.after)} ({sign(c.delta)})
                      </li>
                    ))}
                    <li className={`mt-1 font-semibold ${dcls(ba.overall.delta)}`}>
                      overall: {fmt(ba.overall.before)} → {fmt(ba.overall.after)} ({sign(ba.overall.delta)})
                    </li>
                  </ul>
                </div>
                <div>
                  <div className="metric-label">Metrics</div>
                  <ul className="mt-1 text-xs">
                    {ba.metrics.map((m, i) => (
                      <li key={i} className={dcls(m.delta, m.metric.includes('filler'))}>
                        {m.metric}: {fmt(m.before)} → {fmt(m.after)} ({sign(m.delta)})
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            )}
          </div>

          {progress && progress.series.length >= 2 && (
            <div className="glass mt-4 p-5">
              <div className="metric-label">Progress ({progress.series.length} sessions)</div>
              <p className="mt-1 text-xs text-white/60">
                overall {sign(progress.trend.overallScore)} · wpm {sign(progress.trend.wpm)} · fillers/min{' '}
                {sign(progress.trend.fillerPerMin)} · vocab variety {sign(progress.trend.vocabularyVariety)}
              </p>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const fmt = (v: number | null) => (v == null ? '—' : Number(v).toFixed(1));
const sign = (v: number | null | undefined) => (v == null ? '—' : v > 0 ? `+${Number(v).toFixed(1)}` : Number(v).toFixed(1));
const dcls = (v: number | null | undefined, invert = false) => {
  if (v == null || v === 0) return 'text-white/60';
  const good = invert ? v < 0 : v > 0;
  return good ? 'text-mint' : 'text-amber';
};
