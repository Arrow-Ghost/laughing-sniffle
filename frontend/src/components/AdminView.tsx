import { useCallback, useEffect, useState } from 'react';
import {
  enqueueJob,
  getAnalytics,
  getConsensus,
  getEventAudit,
  getLeaderboard,
  getMe,
  jobStats,
  listEvents,
  listJobs,
  login,
  logout,
  register,
  runTiebreak,
  RISK_CLS,
  type EventAnalytics,
  type EventRow,
  type Job,
  type Leaderboard,
  type Me,
  type SessionConsensus,
  type TieBreakResult,
} from '@/lib/adminApi';

function Card({ title, children, aside }: { title: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <section className="rounded-2xl border border-stroke bg-white/[0.02] p-5">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-sm font-semibold tracking-tight text-white/80">{title}</h2>
        {aside}
      </div>
      {children}
    </section>
  );
}

const fmt = (n: number | null | undefined, d = 1) => (n == null ? '—' : n.toFixed(d));

function AuthStrip({ me, onChange }: { me: Me; onChange: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setErr(null);
    try {
      if (mode === 'login') await login(email, password);
      else await register({ name, email, password });
      onChange();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!me.authEnabled) {
    return (
      <div className="rounded-xl border border-mint/25 bg-mint/[0.06] px-4 py-2 text-xs text-mint">
        Auth is disabled on this server (no <code>AUTH_SECRET</code>). Every request runs as a dev admin.
      </div>
    );
  }

  if (me.user) {
    return (
      <div className="flex items-center justify-between rounded-xl border border-stroke bg-white/[0.02] px-4 py-2 text-xs">
        <span className="text-white/70">
          Signed in as <span className="text-white">{me.user.name}</span> · role{' '}
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-white">{me.role}</span>
        </span>
        <button
          className="rounded-lg border border-stroke px-2.5 py-1 text-white/60 hover:text-white"
          onClick={async () => {
            await logout();
            onChange();
          }}
        >
          Sign out
        </button>
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-stroke bg-white/[0.02] p-4">
      <div className="mb-2 flex gap-2 text-xs">
        {(['login', 'register'] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded-lg px-2.5 py-1 ${mode === m ? 'bg-white/10 text-white' : 'text-white/50'}`}
          >
            {m === 'login' ? 'Sign in' : 'Create account'}
          </button>
        ))}
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {mode === 'register' && (
          <input
            className="rounded-lg border border-stroke bg-black/20 px-3 py-1.5 text-sm"
            placeholder="Name"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        )}
        <input
          className="rounded-lg border border-stroke bg-black/20 px-3 py-1.5 text-sm"
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
        <input
          className="rounded-lg border border-stroke bg-black/20 px-3 py-1.5 text-sm"
          placeholder="Password (8+ chars)"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
      {err && <p className="mt-2 text-xs text-rose">{err}</p>}
      <button
        disabled={busy}
        onClick={submit}
        className="mt-3 rounded-lg bg-gradient-to-br from-cyan to-mint px-3 py-1.5 text-sm font-medium text-ink disabled:opacity-50"
      >
        {mode === 'login' ? 'Sign in' : 'Create account'}
      </button>
      <p className="mt-2 text-[11px] text-white/35">The first account created on a fresh server becomes the admin.</p>
    </div>
  );
}

export default function AdminView() {
  const [me, setMe] = useState<Me | null>(null);
  const [events, setEvents] = useState<EventRow[]>([]);
  const [eventId, setEventId] = useState<string>('');
  const [board, setBoard] = useState<Leaderboard | null>(null);
  const [analytics, setAnalytics] = useState<EventAnalytics | null>(null);
  const [audit, setAudit] = useState<{ id: string; createdAt: number; actor: string; action: string }[]>([]);
  const [tie, setTie] = useState<TieBreakResult | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [stats, setStats] = useState<{ queued: number; running: number; done: number; failed: number } | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [consensus, setConsensus] = useState<SessionConsensus | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refreshMe = useCallback(() => {
    getMe().then(setMe).catch(() => setMe({ authEnabled: true, role: 'participant', dev: false, user: null }));
  }, []);

  useEffect(() => {
    refreshMe();
    listEvents().then(setEvents).catch(() => {});
  }, [refreshMe]);

  const loadEvent = useCallback(async (id: string) => {
    setError(null);
    setBoard(null);
    setAnalytics(null);
    setAudit([]);
    setTie(null);
    if (!id) return;
    try {
      setBoard(await getLeaderboard(id, 'admin').catch(() => getLeaderboard(id, 'public')));
    } catch (e: any) {
      setError(e.message);
    }
    getAnalytics(id).then(setAnalytics).catch(() => {});
    getEventAudit(id).then(setAudit).catch(() => {});
  }, []);

  useEffect(() => {
    if (eventId) void loadEvent(eventId);
  }, [eventId, loadEvent]);

  const refreshJobs = useCallback(() => {
    listJobs().then(setJobs).catch(() => {});
    jobStats().then(setStats).catch(() => {});
  }, []);
  useEffect(() => {
    refreshJobs();
    const t = setInterval(refreshJobs, 4000);
    return () => clearInterval(t);
  }, [refreshJobs]);

  if (!me) return <div className="mx-auto max-w-6xl px-4 py-16 text-white/50">Loading…</div>;

  return (
    <div className="mx-auto max-w-6xl space-y-5 px-4 py-8">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Admin console</h1>
        <p className="text-xs text-white/45">
          Competition operations: consensus, leaderboard, analytics, audit and the job queue. The public leaderboard
          shows a status label only — never a risk level.
        </p>
      </div>

      <AuthStrip me={me} onChange={refreshMe} />
      {error && <p className="text-xs text-rose">{error}</p>}

      <Card
        title="Event"
        aside={
          <select
            className="rounded-lg border border-stroke bg-black/20 px-2 py-1 text-xs"
            value={eventId}
            onChange={(e) => setEventId(e.target.value)}
          >
            <option value="">Select an event…</option>
            {events.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name} ({e.status})
              </option>
            ))}
          </select>
        }
      >
        {!eventId && <p className="text-xs text-white/40">Pick an event to see its standings and analytics.</p>}
        {board && (
          <div className="overflow-x-auto">
            <div className="mb-2 flex items-center gap-2">
              <span
                className={`rounded-full border px-2 py-0.5 text-[11px] ${
                  board.view === 'admin' ? 'border-cyan/40 text-cyan' : 'border-white/15 text-white/50'
                }`}
              >
                {board.view} view
              </span>
              <button
                onClick={() => runTiebreak(eventId).then(setTie).catch((e) => setError(e.message))}
                className="rounded-lg border border-stroke px-2.5 py-1 text-[11px] text-white/60 hover:text-white"
              >
                Run tie-break
              </button>
            </div>
            <table className="w-full text-left text-xs">
              <thead className="text-white/40">
                <tr>
                  <th className="py-1 pr-3">#</th>
                  <th className="py-1 pr-3">Participant</th>
                  <th className="py-1 pr-3">Score</th>
                  <th className="py-1 pr-3">Sessions</th>
                  <th className="py-1 pr-3">Integrity</th>
                  {board.view === 'admin' && <th className="py-1 pr-3">Agreement</th>}
                  {board.view === 'admin' && <th className="py-1 pr-3">Risk (internal)</th>}
                </tr>
              </thead>
              <tbody>
                {board.rows.map((r) => (
                  <tr key={r.participantId} className="border-t border-white/5">
                    <td className="py-1.5 pr-3 text-white/50">{r.rank}</td>
                    <td className="py-1.5 pr-3 text-white/90">{r.participantLabel}</td>
                    <td className="py-1.5 pr-3 tabular-nums">
                      {r.overallScore == null ? '—' : `${fmt(r.overallScore)} / ${r.scaleMax}`}
                    </td>
                    <td className="py-1.5 pr-3 text-white/50">{r.sessionsScored}</td>
                    <td className="py-1.5 pr-3">
                      <span
                        className={
                          r.integrityStatus === 'under-review' ? 'text-amber' : 'text-white/40'
                        }
                      >
                        {r.integrityStatus === 'under-review' ? 'under review' : 'clear'}
                      </span>
                    </td>
                    {board.view === 'admin' && (
                      <td className="py-1.5 pr-3 text-white/60">{r.admin?.agreement ?? '—'}</td>
                    )}
                    {board.view === 'admin' && (
                      <td className={`py-1.5 pr-3 ${r.admin?.integrityRisk ? RISK_CLS[r.admin.integrityRisk] : 'text-white/30'}`}>
                        {r.admin?.integrityRisk ?? '—'}
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-2 text-[11px] text-white/35">{board.note}</p>
          </div>
        )}
        {tie && (
          <div className="mt-4 rounded-xl border border-stroke bg-black/20 p-3 text-xs">
            <p className="mb-1 text-white/60">Tie-break — rules: {tie.rulesApplied.join(' → ')}</p>
            <ol className="space-y-1">
              {tie.entries.map((e, i) => (
                <li key={i} className="text-white/70">
                  <span className="text-white/40">#{e.rank}</span> {e.participantLabel} · {fmt(e.overallScore)}
                  {e.brokenBy && <span className="text-white/40"> — {e.brokenBy}</span>}
                  {e.tiedWithPrevious && <span className="text-amber"> — still tied</span>}
                </li>
              ))}
            </ol>
            <p className="mt-1 text-[11px] text-white/35">{tie.note}</p>
          </div>
        )}
      </Card>

      {analytics && (
        <Card title={`Analytics — ${analytics.eventName}`}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat label="Participants" value={analytics.participants} />
            <Stat label="Sessions" value={`${analytics.sessionsEnded}/${analytics.sessions}`} />
            <Stat label="Evaluations" value={`${analytics.finalEvaluations} final`} />
            <Stat
              label="Mean score"
              value={`${fmt(analytics.scoreDistribution.mean)} / ${analytics.scoreDistribution.scaleMax}`}
            />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div>
              <p className="mb-2 text-[11px] uppercase tracking-wide text-white/40">Score distribution</p>
              <div className="space-y-1">
                {analytics.scoreDistribution.histogram.map((h) => {
                  const max = Math.max(1, ...analytics.scoreDistribution.histogram.map((x) => x.count));
                  return (
                    <div key={h.bucket} className="flex items-center gap-2 text-[11px]">
                      <span className="w-16 text-white/40">{h.bucket}</span>
                      <div className="h-3 flex-1 rounded bg-white/5">
                        <div className="h-3 rounded bg-cyan/50" style={{ width: `${(h.count / max) * 100}%` }} />
                      </div>
                      <span className="w-6 tabular-nums text-white/50">{h.count}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            <div>
              <p className="mb-2 text-[11px] uppercase tracking-wide text-white/40">Judge calibration</p>
              <table className="w-full text-left text-[11px]">
                <thead className="text-white/35">
                  <tr>
                    <th className="pr-2">Judge</th>
                    <th className="pr-2">n</th>
                    <th className="pr-2">Mean given</th>
                    <th className="pr-2">vs room</th>
                  </tr>
                </thead>
                <tbody>
                  {analytics.judgeStats.map((j) => (
                    <tr key={j.judgeId} className="border-t border-white/5">
                      <td className="py-1 pr-2 text-white/70">{j.judgeId}</td>
                      <td className="py-1 pr-2 text-white/50">{j.evaluations}</td>
                      <td className="py-1 pr-2 tabular-nums">{fmt(j.meanScoreGiven)}</td>
                      <td
                        className={`py-1 pr-2 tabular-nums ${
                          j.meanDeviationFromConsensus > 0.3
                            ? 'text-mint'
                            : j.meanDeviationFromConsensus < -0.3
                              ? 'text-amber'
                              : 'text-white/50'
                        }`}
                      >
                        {j.meanDeviationFromConsensus > 0 ? '+' : ''}
                        {fmt(j.meanDeviationFromConsensus, 2)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="mt-4">
            <p className="mb-2 text-[11px] uppercase tracking-wide text-white/40">Integrity (counts only)</p>
            <div className="flex flex-wrap gap-2 text-[11px]">
              {(['LOW', 'MODERATE', 'HIGH', 'CRITICAL'] as const).map((k) => (
                <span key={k} className={`rounded border border-white/10 px-2 py-0.5 ${RISK_CLS[k]}`}>
                  {k}: {analytics.integritySummary.byRisk[k]}
                </span>
              ))}
              <span className="rounded border border-white/10 px-2 py-0.5 text-white/60">
                confirmed by a human: {analytics.integritySummary.confirmedByHuman}
              </span>
            </div>
            <p className="mt-1 text-[11px] text-white/35">{analytics.integritySummary.note}</p>
          </div>
        </Card>
      )}

      <div className="grid gap-5 lg:grid-cols-2">
        <Card title="Session consensus">
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-lg border border-stroke bg-black/20 px-3 py-1.5 text-sm"
              placeholder="Session ID"
              value={sessionId}
              onChange={(e) => setSessionId(e.target.value)}
            />
            <button
              onClick={() => getConsensus(sessionId).then(setConsensus).catch((e) => setError(e.message))}
              className="rounded-lg border border-stroke px-3 py-1.5 text-sm text-white/70 hover:text-white"
            >
              Load
            </button>
          </div>
          {consensus && (
            <div className="mt-3 text-xs">
              <p className="text-white/70">
                {consensus.judgeCount} judges ({consensus.humanJudgeCount} human) · mean{' '}
                <span className="tabular-nums">{fmt(consensus.overallMean)}</span> / {consensus.scaleMax} · spread{' '}
                <span className="tabular-nums">{fmt(consensus.overallSpread)}</span> ·{' '}
                <span
                  className={
                    consensus.agreement === 'weak'
                      ? 'text-amber'
                      : consensus.agreement === 'strong'
                        ? 'text-mint'
                        : 'text-cyan'
                  }
                >
                  {consensus.agreement} agreement
                </span>
              </p>
              {consensus.divergentCriteria.length > 0 && (
                <p className="mt-1 text-amber">Judges disagree on: {consensus.divergentCriteria.join(', ')}</p>
              )}
              <table className="mt-2 w-full text-left text-[11px]">
                <tbody>
                  {consensus.criteria.map((c) => (
                    <tr key={c.criterionName} className="border-t border-white/5">
                      <td className="py-1 pr-2 text-white/70">{c.criterionName}</td>
                      <td className="py-1 pr-2 tabular-nums">{fmt(c.mean)}</td>
                      <td className="py-1 pr-2 text-white/40">
                        {c.min}–{c.max}
                      </td>
                      <td className={`py-1 ${c.diverges ? 'text-amber' : 'text-white/30'}`}>
                        {c.diverges ? 'diverges' : 'agree'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="mt-1 text-[11px] text-white/35">{consensus.note}</p>
            </div>
          )}
        </Card>

        <Card
          title="Job queue"
          aside={
            <span className="text-[11px] text-white/40">
              {stats ? `${stats.queued} queued · ${stats.running} running · ${stats.done} done · ${stats.failed} failed` : ''}
            </span>
          }
        >
          <div className="mb-2 flex gap-2">
            <button
              disabled={!eventId}
              onClick={() => enqueueJob('event.analytics', { eventId }).then(refreshJobs).catch((e) => setError(e.message))}
              className="rounded-lg border border-stroke px-2.5 py-1 text-[11px] text-white/60 hover:text-white disabled:opacity-40"
            >
              Queue analytics for selected event
            </button>
          </div>
          <div className="max-h-56 space-y-1 overflow-y-auto text-[11px]">
            {jobs.length === 0 && <p className="text-white/35">No jobs.</p>}
            {jobs.map((j) => (
              <div key={j.id} className="flex items-center justify-between border-t border-white/5 py-1">
                <span className="text-white/60">{j.kind}</span>
                <span
                  className={
                    j.status === 'done'
                      ? 'text-mint'
                      : j.status === 'failed'
                        ? 'text-rose'
                        : j.status === 'running'
                          ? 'text-cyan'
                          : 'text-white/40'
                  }
                >
                  {j.status}
                  {j.attempts > 1 ? ` (×${j.attempts})` : ''}
                </span>
              </div>
            ))}
          </div>
        </Card>
      </div>

      <Card title="Audit log">
        <div className="max-h-64 space-y-1 overflow-y-auto text-[11px]">
          {audit.length === 0 && <p className="text-white/35">No audit entries for this event.</p>}
          {audit
            .slice()
            .reverse()
            .map((a) => (
              <div key={a.id} className="flex gap-3 border-t border-white/5 py-1">
                <span className="w-36 shrink-0 text-white/35">{new Date(a.createdAt).toLocaleString()}</span>
                <span className="w-24 shrink-0 text-white/50">{a.actor}</span>
                <span className="text-white/75">{a.action}</span>
              </div>
            ))}
        </div>
      </Card>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-stroke bg-black/20 px-3 py-2">
      <p className="text-[11px] uppercase tracking-wide text-white/40">{label}</p>
      <p className="mt-0.5 text-sm text-white/90">{value}</p>
    </div>
  );
}
