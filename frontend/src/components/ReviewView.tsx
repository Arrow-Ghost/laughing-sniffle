import { useEffect, useMemo, useState } from 'react';
import LanguageLine from './LanguageLine';
import {
  clock,
  DECISION_COPY,
  getCase,
  getEventIntegrity,
  getGraph,
  getParticipantView,
  getSessionIntegrity,
  respondAppeal,
  reviewCase,
  RISK_COPY,
  runIntegrity,
  type IntegrityAppeal,
  type IntegrityCase,
  type ReviewDecision,
  type SourceGraph,
} from '@/lib/reviewApi';

function q(key: string) {
  return useMemo(() => {
    if (typeof window === 'undefined') return null;
    return new URLSearchParams(window.location.search).get(key);
  }, [key]);
}

const CONF_CLS: Record<string, string> = {
  high: 'border-mint/40 bg-mint/10 text-mint',
  medium: 'border-cyan/40 bg-cyan/10 text-cyan',
  low: 'border-amber/40 bg-amber/10 text-amber',
};

function Bar({ v, tone = '#00D4FF' }: { v: number; tone?: string }) {
  return (
    <div className="bar-track h-1.5 w-28 overflow-hidden rounded-full">
      <div className="h-full rounded-full" style={{ width: `${Math.max(3, Math.min(100, v * 100))}%`, background: tone }} />
    </div>
  );
}

function AppealResponder({ appealId, onDone }: { appealId: string; onDone: () => void }) {
  const [f, setF] = useState({ reviewerId: '', decision: 'rejected', reason: '' });
  const [busy, setBusy] = useState(false);
  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5">
      <input
        className="rounded border border-stroke bg-black/30 px-2 py-1 text-[11px] outline-none"
        placeholder="reviewer id"
        value={f.reviewerId}
        onChange={(e) => setF({ ...f, reviewerId: e.target.value })}
      />
      <select
        className="rounded border border-stroke bg-black/30 px-2 py-1 text-[11px] outline-none"
        value={f.decision}
        onChange={(e) => setF({ ...f, decision: e.target.value })}
      >
        <option value="rejected">reject</option>
        <option value="partially-upheld">partially uphold</option>
        <option value="upheld">uphold (clears the case)</option>
      </select>
      <input
        className="min-w-[10rem] flex-1 rounded border border-stroke bg-black/30 px-2 py-1 text-[11px] outline-none"
        placeholder="reason"
        value={f.reason}
        onChange={(e) => setF({ ...f, reason: e.target.value })}
      />
      <button
        className="btn !px-2 !py-1 text-[11px]"
        disabled={busy || !f.reviewerId.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            await respondAppeal(appealId, f);
            onDone();
          } finally {
            setBusy(false);
          }
        }}
      >
        respond
      </button>
    </div>
  );
}

function CaseCard({ c, onReviewed }: { c: IntegrityCase; onReviewed: (c: IntegrityCase) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [form, setForm] = useState({ reviewerId: '', decision: 'monitor' as ReviewDecision, reason: '', notes: '' });
  const [graph, setGraph] = useState<SourceGraph | null>(null);
  const [graphBusy, setGraphBusy] = useState(false);
  const [appeals, setAppeals] = useState<IntegrityAppeal[]>([]);
  const risk = RISK_COPY[c.riskLevel];
  const present = c.signals.filter((s) => s.present);

  async function loadGraph() {
    if (graph) {
      setGraph(null);
      return;
    }
    setGraphBusy(true);
    try {
      setGraph(await getGraph(c.id));
    } finally {
      setGraphBusy(false);
    }
  }
  async function loadAppeals() {
    try {
      const v = await getParticipantView(c.id);
      setAppeals(Array.isArray(v.appeals) ? v.appeals : []);
    } catch {
      /* ignore */
    }
  }
  useEffect(() => {
    void loadAppeals();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [c.id]);

  async function submit() {
    if (!form.reviewerId.trim()) {
      setErr('Enter your reviewer id — only a named human can record a decision.');
      return;
    }
    if (form.decision === 'confirm' && !form.reason.trim()) {
      setErr('Confirming a violation needs a reason.');
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      onReviewed(await reviewCase(c.id, form));
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="glass p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-xs font-semibold ${risk.cls}`}>{risk.label}</span>
          <span className={`rounded-full border px-2 py-0.5 text-[11px] ${CONF_CLS[c.confidence]}`}>{c.confidence} confidence</span>
          <span className="text-[11px] text-white/40">session {c.sessionId.slice(0, 8)}</span>
        </div>
        <span className="text-[11px] text-white/45">
          status: <span className="text-white/70">{c.status.replace('_', ' ')}</span>
        </span>
      </div>

      <LanguageLine sessionId={c.sessionId} />
      <p className="mt-3 text-sm text-white/75">{c.recommendation}</p>

      {present.length > 0 ? (
        <div className="mt-4 space-y-3">
          <div className="metric-label">Signals ({present.length}, from {new Set(present.map((s) => s.origin)).size} independent source{new Set(present.map((s) => s.origin)).size === 1 ? '' : 's'})</div>
          {present.map((s) => (
            <div key={s.key} className="rounded-lg border border-white/5 bg-black/15 p-3">
              <div className="flex items-center justify-between gap-3">
                <span className="text-sm text-white/85">{s.label}</span>
                <div className="flex items-center gap-2">
                  <Bar v={s.strength} tone={c.riskLevel === 'CRITICAL' ? '#FF5C7A' : c.riskLevel === 'HIGH' ? '#FFB800' : '#00D4FF'} />
                  <span className="text-[11px] text-white/35">{s.origin}</span>
                </div>
              </div>
              {s.evidence.length > 0 && (
                <ul className="mt-1.5 list-disc space-y-0.5 pl-4 text-xs text-white/60">
                  {s.evidence.map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-xs text-white/45">No signals fired. Recorded for completeness.</p>
      )}

      {c.sourceMatches.length > 0 && (
        <div className="mt-4">
          <div className="metric-label">External source matches</div>
          <ul className="mt-1.5 space-y-1.5">
            {c.sourceMatches.slice(0, 6).map((m, i) => (
              <li key={i} className="text-xs">
                <span className="text-white/45">{m.atMs != null ? `${clock(m.atMs)} · ` : ''}</span>
                <span className="text-white/80">“{m.phrase.slice(0, 110)}{m.phrase.length > 110 ? '…' : ''}”</span>
                <div className="mt-0.5 text-white/45">
                  {m.domain} <span className="text-white/30">({m.sourceType}, credibility {Math.round(m.credibility * 100)}%)</span> ·{' '}
                  {Math.round(m.exactSimilarity * 100)}% word overlap · {m.quotationClass}
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-1.5 text-[11px] text-white/35">{c.searchCoverage}</p>
        </div>
      )}

      {c.participantMatches.length > 0 && (
        <div className="mt-4">
          <div className="metric-label">Overlap with other submissions in this event</div>
          <ul className="mt-1.5 space-y-1 text-xs text-white/65">
            {c.participantMatches.map((p, i) => (
              <li key={i}>
                <span className="text-white/80">{p.otherLabel}</span> — {p.note} ({Math.round(p.similarity * 100)}%)
                {p.sharedDistinctivePhrases.length > 0 && (
                  <ul className="mt-0.5 list-disc pl-4 text-white/45">
                    {p.sharedDistinctivePhrases.slice(0, 3).map((s, j) => (
                      <li key={j}>“{s.slice(0, 90)}…”</li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {c.styleAnalysis && (
        <div className="mt-4">
          <div className="metric-label">Style vs. this speaker’s own baseline</div>
          {c.styleAnalysis.hasBaseline ? (
            <>
              <p className="mt-1 text-xs text-white/65">
                Overall shift {Math.round(c.styleAnalysis.overallShift * 100)}% (from {c.styleAnalysis.sessionsInBaseline} prior sessions)
                {c.styleAnalysis.reasons.length > 0 && ` — ${c.styleAnalysis.reasons.join('; ')}`}
              </p>
              <p className="mt-1 text-[11px] text-white/35">{c.styleAnalysis.caveat}</p>
            </>
          ) : (
            <p className="mt-1 text-xs text-white/45">{c.styleAnalysis.reasons[0]}</p>
          )}
        </div>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div>
          <div className="metric-label">Preparedness (observation)</div>
          <p className="mt-1 text-xs text-white/65">
            <span className="text-white/85">{c.preparedness.classification.replace('-', ' ')}</span>
            {c.preparedness.indicators.length > 0 && ` — ${c.preparedness.indicators.slice(0, 3).join(', ')}`}
          </p>
          <p className="mt-1 text-[11px] text-white/35">{c.preparedness.note}</p>
        </div>
        <div>
          <div className="metric-label">Session integrity {c.sessionIntegrity.hashed ? '· hashed' : ''}</div>
          {c.sessionIntegrity.anomalies.length === 0 ? (
            <p className="mt-1 text-xs text-white/45">No inconsistencies in the recording.</p>
          ) : (
            <ul className="mt-1 space-y-0.5 text-xs">
              {c.sessionIntegrity.anomalies.map((a, i) => (
                <li key={i} className={a.severity === 'concern' ? 'text-rose' : a.severity === 'notable' ? 'text-amber' : 'text-white/55'}>
                  {a.atMs != null ? `${clock(a.atMs)} · ` : ''}
                  {a.type} — {a.detail}
                </li>
              ))}
            </ul>
          )}
          <p className="mt-1 text-[11px] text-white/35">{c.sessionIntegrity.note}</p>
        </div>
      </div>

      {(c.sourceMatches.length > 0 || c.participantMatches.length > 0) && (
        <div className="mt-4">
          <button className="btn !px-3 !py-1 text-xs" onClick={loadGraph} disabled={graphBusy}>
            {graph ? 'Hide source graph' : graphBusy ? 'Loading…' : 'Source graph'}
          </button>
          {graph && (
            <ul className="mt-2 space-y-1 text-xs text-white/60">
              {graph.edges.map((e, i) => {
                const to = graph.nodes.find((n) => n.id === e.to);
                return (
                  <li key={i}>
                    this submission → <span className="text-white/85">{to?.label}</span>{' '}
                    <span className="text-white/35">({to?.kind === 'source' ? 'source' : 'other submission'}, weight {Math.round(e.weight * 100)}%)</span> — {e.evidence}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      <div className="mt-4 rounded-lg border border-white/10 bg-white/[0.02] p-3">
        <div className="metric-label text-white/50">What this does not establish</div>
        <p className="mt-1 text-xs leading-relaxed text-white/60">{c.notProvedNote}</p>
      </div>

      {appeals.length > 0 && (
        <div className="mt-4">
          <div className="metric-label">Appeals</div>
          {appeals.map((a) => (
            <div key={a.id} className="mt-1.5 rounded-lg border border-white/10 bg-black/15 p-2.5 text-xs">
              <div className="text-white/70">
                <span className="text-white/45">{a.submittedBy}:</span> “{a.statement}”
                {a.sourceAttribution && <div className="mt-0.5 text-white/45">Attribution offered: {a.sourceAttribution}</div>}
              </div>
              {a.response ? (
                <div className="mt-1.5 text-mint">
                  {a.response.reviewerId}: {a.response.decision} — “{a.response.reason}”
                </div>
              ) : (
                <AppealResponder appealId={a.id} onDone={() => void loadAppeals()} />
              )}
            </div>
          ))}
        </div>
      )}

      {c.review ? (
        <div className="mt-4 rounded-lg border border-mint/20 bg-mint/5 p-3 text-xs text-white/70">
          <span className="text-mint">Reviewed</span> by {c.review.reviewerId} —{' '}
          <strong>{DECISION_COPY[c.review.decision]}</strong>
          {c.review.reason && <> · “{c.review.reason}”</>}
          {c.review.notes && <div className="mt-1 text-white/45">Notes: {c.review.notes}</div>}
        </div>
      ) : (
        <div className="mt-4 border-t border-white/5 pt-4">
          <div className="metric-label">Record a decision</div>
          {err && <p className="mt-1 text-xs text-rose">{err}</p>}
          <div className="mt-2 grid gap-2 sm:grid-cols-[auto_1fr]">
            <input
              className="rounded-lg border border-stroke bg-black/30 px-3 py-1.5 text-sm outline-none focus:border-cyan/50"
              placeholder="your reviewer id"
              value={form.reviewerId}
              onChange={(e) => setForm({ ...form, reviewerId: e.target.value })}
            />
            <select
              className="rounded-lg border border-stroke bg-black/30 px-3 py-1.5 text-sm outline-none focus:border-cyan/50"
              value={form.decision}
              onChange={(e) => setForm({ ...form, decision: e.target.value as ReviewDecision })}
            >
              {(Object.keys(DECISION_COPY) as ReviewDecision[]).map((d) => (
                <option key={d} value={d}>
                  {DECISION_COPY[d]}
                </option>
              ))}
            </select>
          </div>
          <textarea
            className="mt-2 w-full rounded-lg border border-stroke bg-black/30 px-3 py-1.5 text-sm outline-none focus:border-cyan/50"
            rows={2}
            placeholder="reason (required to confirm a violation)"
            value={form.reason}
            onChange={(e) => setForm({ ...form, reason: e.target.value })}
          />
          <button className="btn btn-primary mt-2" disabled={busy} onClick={submit}>
            {busy ? 'Recording…' : 'Record decision'}
          </button>
        </div>
      )}
    </div>
  );
}

export default function ReviewView() {
  const sessionId = q('session');
  const eventId = q('event');
  const caseId = q('case');

  const [cases, setCases] = useState<IntegrityCase[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  async function load() {
    setError(null);
    try {
      if (caseId) {
        setCases([await getCase(caseId)]);
      } else if (eventId) {
        setCases(await getEventIntegrity(eventId));
      } else if (sessionId) {
        setCases((await getSessionIntegrity(sessionId)).cases);
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoaded(true);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, eventId, caseId]);

  async function analyse() {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await runIntegrity(sessionId);
      if (r.case) setCases([r.case]);
      else setError('This event permits AI assistance — recorded as disclosure analytics, no review case.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const replace = (c: IntegrityCase) => setCases((prev) => prev.map((x) => (x.id === c.id ? c : x)));

  if (!sessionId && !eventId && !caseId) {
    return (
      <div className="mx-auto max-w-lg px-4 py-16 text-sm text-white/55">
        Open as <code className="text-white/80">/review?session=&lt;id&gt;</code>,{' '}
        <code className="text-white/80">/review?event=&lt;id&gt;</code>, or{' '}
        <code className="text-white/80">/review?case=&lt;id&gt;</code>.
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-4xl px-4 py-8">
      <header className="mb-4">
        <h1 className="text-lg font-semibold">Integrity review</h1>
        <p className="mt-1 text-sm text-white/50">
          Risk levels and evidence — not verdicts. A named human reviewer records every decision, and no
          result should be published while a case is under review.
        </p>
      </header>

      {error && <div className="mb-4 rounded-xl border border-rose/40 bg-rose/10 px-4 py-2 text-sm text-rose">{error}</div>}

      {loaded && cases.length === 0 && sessionId && (
        <div className="glass p-6">
          <p className="text-sm text-white/55">No integrity analysis has been run for this session yet.</p>
          <button className="btn btn-primary mt-3" disabled={busy} onClick={analyse}>
            {busy ? 'Analysing…' : 'Run integrity analysis'}
          </button>
        </div>
      )}

      <div className="space-y-4">
        {cases.map((c) => (
          <CaseCard key={c.id} c={c} onReviewed={replace} />
        ))}
      </div>
    </div>
  );
}
