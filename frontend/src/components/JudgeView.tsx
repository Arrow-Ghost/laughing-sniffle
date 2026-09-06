import { useEffect, useMemo, useState } from 'react';
import LanguageLine from './LanguageLine';
import {
  clock,
  finalizeEvaluation,
  getEvaluation,
  getTimeline,
  listEvaluations,
  listRubrics,
  overrideCriterion,
  reopenEvaluation,
  runEvaluation,
  type Confidence,
  type CriterionScore,
  type JudgeEvaluation,
  type TimelineEvent,
} from '@/lib/judgeApi';

const CONF: Record<Confidence, { label: string; cls: string }> = {
  high: { label: 'High confidence', cls: 'border-mint/40 bg-mint/10 text-mint' },
  medium: { label: 'Medium confidence', cls: 'border-cyan/40 bg-cyan/10 text-cyan' },
  low: { label: 'Low confidence', cls: 'border-amber/40 bg-amber/10 text-amber' },
};

function Pill({ conf }: { conf: Confidence }) {
  const c = CONF[conf];
  return <span className={`rounded-full border px-2 py-0.5 text-[11px] font-medium ${c.cls}`}>{c.label}</span>;
}

function useQuery(key: string) {
  return useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get(key);
  }, [key]);
}

export default function JudgeView() {
  const sessionId = useQuery('session');
  const evalIdParam = useQuery('evaluation');

  const [evaluation, setEvaluation] = useState<JudgeEvaluation | null>(null);
  const [timeline, setTimeline] = useState<TimelineEvent[]>([]);
  const [rubrics, setRubrics] = useState<{ id: string; name: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setError(null);
    try {
      if (evalIdParam) {
        const ev = await getEvaluation(evalIdParam);
        setEvaluation(ev);
        setTimeline(await getTimeline(ev.sessionId));
        return;
      }
      if (!sessionId) return;
      const list = await listEvaluations(sessionId);
      setEvaluation(list.at(-1) ?? null);
      setTimeline(await getTimeline(sessionId));
      if (list.length === 0) setRubrics(await listRubrics().catch(() => []));
    } catch (e: any) {
      setError(e.message);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, evalIdParam]);

  async function doRun(rubricId?: string) {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const ev = await runEvaluation(sessionId, rubricId);
      setEvaluation(ev);
      setTimeline(await getTimeline(sessionId));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doOverride(c: CriterionScore) {
    if (!evaluation) return;
    const raw = window.prompt(
      `New score for "${c.criterionName}" (${1}–${evaluation.scaleMax}). AI proposed ${c.aiScore ?? '—'}.`,
      String(c.score),
    );
    if (raw == null) return;
    const score = Number(raw);
    if (!Number.isFinite(score)) return;
    const reason = window.prompt('Reason for the override (recorded in the audit trail):', '') ?? '';
    setBusy(true);
    try {
      setEvaluation(await overrideCriterion(evaluation.id, c.criterionId, score, reason));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doFinalize() {
    if (!evaluation) return;
    const notes = window.prompt('Finalise this evaluation. Optional panel notes:', evaluation.notes ?? '') ?? '';
    setBusy(true);
    try {
      setEvaluation(await finalizeEvaluation(evaluation.id, notes));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function doReopen() {
    if (!evaluation) return;
    setBusy(true);
    try {
      setEvaluation(await reopenEvaluation(evaluation.id));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!sessionId && !evalIdParam) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-sm text-white/55">
        Open this view as <code className="text-white/80">/judge?session=&lt;id&gt;</code> or{' '}
        <code className="text-white/80">/judge?evaluation=&lt;id&gt;</code>. Session ids come from the console
        (Network tab) or <code className="text-white/80">GET /api/sessions</code>.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8">
      {error && (
        <div className="mb-4 rounded-xl border border-rose/40 bg-rose/10 px-4 py-2 text-sm text-rose">{error}</div>
      )}

      {!evaluation ? (
        <div className="glass p-6">
          <h1 className="text-lg font-semibold">No evaluation yet</h1>
          <p className="mt-1 text-sm text-white/50">
            Run the AI judge against this session. It scores every rubric criterion with evidence, confidence
            and reasoning — a recommendation you can adjust.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <button className="btn btn-primary" disabled={busy} onClick={() => doRun()}>
              {busy ? 'Judging…' : 'Run evaluation (event rubric)'}
            </button>
            {rubrics.map((r) => (
              <button key={r.id} className="btn" disabled={busy} onClick={() => doRun(r.id)}>
                Use “{r.name}”
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <header className="glass mb-4 flex flex-wrap items-center justify-between gap-3 p-5">
            <div>
              <div className="metric-label">{evaluation.rubricName}</div>
              <div className="mt-1 flex items-baseline gap-3">
                <span className="font-mono text-3xl font-semibold">
                  {evaluation.overallScore.toFixed(1)}
                  <span className="text-base text-white/40"> / {evaluation.scaleMax}</span>
                </span>
                <Pill conf={evaluation.overallConfidence} />
                <span
                  className={`rounded-full border px-2 py-0.5 text-[11px] ${
                    evaluation.status === 'final'
                      ? 'border-mint/40 bg-mint/10 text-mint'
                      : 'border-white/15 text-white/50'
                  }`}
                >
                  {evaluation.status === 'final' ? 'Finalised' : 'Draft'}
                </span>
                <span className="text-[11px] text-white/40">
                  {evaluation.judgeType === 'human' ? 'AI + human' : 'AI recommendation'}
                </span>
              </div>
              <LanguageLine sessionId={evaluation.sessionId} />
            </div>
            <div className="flex gap-2">
              {evaluation.status === 'draft' ? (
                <button className="btn btn-primary" disabled={busy} onClick={doFinalize}>
                  Finalise
                </button>
              ) : (
                <button className="btn" disabled={busy} onClick={doReopen}>
                  Reopen
                </button>
              )}
            </div>
          </header>

          <div className="grid gap-3">
            {evaluation.criteria.map((c) => (
              <div key={c.criterionId} className="glass p-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="flex items-baseline gap-3">
                    <h3 className="text-sm font-semibold text-white/90">{c.criterionName}</h3>
                    <span className="text-[11px] text-white/35">{Math.round(c.weight * 100)}% of total</span>
                    <Pill conf={c.confidence} />
                  </div>
                  <div className="flex items-baseline gap-2 font-mono">
                    <span className="text-xl font-semibold">{c.score}</span>
                    {c.humanScore != null && c.aiScore != null && c.humanScore !== c.aiScore && (
                      <span className="text-[11px] text-white/40">
                        AI {c.aiScore} → human {c.humanScore}
                      </span>
                    )}
                    {evaluation.status === 'draft' && (
                      <button className="btn !px-2 !py-0.5 text-[11px]" disabled={busy} onClick={() => doOverride(c)}>
                        Adjust
                      </button>
                    )}
                  </div>
                </div>

                {c.confidenceReasons.length > 0 && (
                  <p className="mt-1.5 text-[11px] text-amber/80">Confidence limited by: {c.confidenceReasons.join('; ')}</p>
                )}
                {c.overrideReason && (
                  <p className="mt-1.5 text-[11px] text-white/45">
                    Overridden by {c.overriddenBy}: “{c.overrideReason}”
                  </p>
                )}

                {c.reasoning && <p className="mt-2 text-sm leading-relaxed text-white/75">{c.reasoning}</p>}

                {(c.strengths.length > 0 || c.weaknesses.length > 0) && (
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    {c.strengths.length > 0 && (
                      <div>
                        <div className="metric-label text-mint/70">Strengths</div>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-white/70">
                          {c.strengths.map((x, i) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {c.weaknesses.length > 0 && (
                      <div>
                        <div className="metric-label text-amber/70">To work on</div>
                        <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs text-white/70">
                          {c.weaknesses.map((x, i) => (
                            <li key={i}>{x}</li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {c.evidence.length > 0 && (
                  <div className="mt-3 border-t border-white/5 pt-2">
                    <div className="metric-label">Evidence</div>
                    <ul className="mt-1 space-y-1.5">
                      {c.evidence.map((e, i) => (
                        <li key={i} className="text-xs">
                          <span className="font-mono text-white/40">
                            {clock(e.startMs)}–{clock(e.endMs)}
                          </span>{' '}
                          <span className="text-white/80">“{e.quote}”</span>
                          {e.reason && <span className="text-white/45"> — {e.reason}</span>}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            ))}
          </div>

          {timeline.length > 0 && (
            <div className="glass mt-4 p-5">
              <h3 className="mb-2 text-sm font-semibold text-white/80">Evidence timeline</h3>
              <ul className="space-y-1 font-mono text-xs text-white/55">
                {timeline.map((e) => (
                  <li key={e.id}>
                    <span className="text-white/35">{clock(e.atMs)}</span>{' '}
                    <span
                      className={
                        e.severity === 'concern'
                          ? 'text-rose'
                          : e.severity === 'notable'
                            ? 'text-amber'
                            : 'text-white/55'
                      }
                    >
                      {e.type}
                    </span>
                    {e.description ? ` · ${e.description}` : ''}
                    <span className="text-white/25"> [{e.source}]</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="mt-4 text-[11px] text-white/35">
            This is a performance evaluation. It says nothing about originality or outside assistance — that is
            a separate review, not folded into these scores.
          </p>
        </>
      )}
    </div>
  );
}
