import { useEffect, useRef, useState } from 'react';
import { createSession, fetchCoaching, fetchIntegrityAnalysis, getHealth, type SessionMode } from '@/lib/api';
import { startCapture, type CaptureHandle } from '@/lib/audio';
import { browserSpeechSupported, startBrowserSpeech } from '@/lib/speech';
import { useConsole } from '@/lib/store';
import { saveHistory, download, toCSV, type HistoryEntry } from '@/lib/history';
import { clock } from '@/lib/format';
import Sphere from './Sphere';
import MetricRail from './MetricRail';
import Timeline from './Timeline';

const MODES: { id: SessionMode; title: string; blurb: string }[] = [
  { id: 'debate-practice', title: 'Debate practice', blurb: 'Rounds, rebuttals, and speaker drills.' },
  { id: 'interview-prep', title: 'Interview prep', blurb: 'Rehearse answers and review your delivery.' },
  { id: 'speech-coaching', title: 'Speech coaching', blurb: 'Presentations, toasts, talks.' },
];

const METRIC_KEYS = ['pace', 'pauses', 'fillers', 'vocabulary', 'delivery', 'latency'] as const;
const PREF_KEY = 'shadowadj.prefs.v1';

type Step = 'setup' | 'consent' | 'live' | 'ended';

interface Prefs {
  mode: SessionMode;
  label: string;
  transcriptSource: 'browser' | 'server';
  languages: string;
  expectSpeakers: number;
  metrics: Record<string, boolean>;
}
function defaultPrefs(): Prefs {
  return {
    mode: 'debate-practice',
    label: '',
    transcriptSource: 'server', // falls back to browser when no Gemini key
    languages: '',
    expectSpeakers: 1,
    metrics: Object.fromEntries(METRIC_KEYS.map((k) => [k, true])),
  };
}
function loadPrefs(): Prefs {
  try {
    return { ...defaultPrefs(), ...(JSON.parse(localStorage.getItem(PREF_KEY) || '{}') as Partial<Prefs>) };
  } catch {
    return defaultPrefs();
  }
}

export default function Console() {
  const [step, setStep] = useState<Step>('setup');
  const [prefs, setPrefs] = useState(loadPrefs);
  const [health, setHealth] = useState<{
    geminiEnabled: boolean;
    provider?: string;
    model?: string;
    defaultTranscription?: 'server' | 'browser';
  } | null>(null);
  const [consent, setConsent] = useState({ speaker: false, second: false });
  const [finalizing, setFinalizing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [coaching, setCoaching] = useState<{ notes: string; loading: boolean; error: string | null }>({
    notes: '',
    loading: false,
    error: null,
  });
  const [integrity, setIntegrity] = useState<{ data: any | null; loading: boolean; error: string | null }>({
    data: null,
    loading: false,
    error: null,
  });

  const store = useConsole();
  const captureRef = useRef<CaptureHandle | null>(null);
  const stopSpeechRef = useRef<() => void>(() => {});
  const exportRef = useRef<any>(null);
  const startedAtRef = useRef<number>(0);

  useEffect(() => {
    getHealth()
      .then(setHealth)
      .catch(() => setError('Backend not reachable on :8787 — is it running?'));
  }, []);

  useEffect(() => {
    localStorage.setItem(PREF_KEY, JSON.stringify(prefs));
  }, [prefs]);

  useEffect(() => () => teardown(), []); // unmount safety

  function teardown() {
    captureRef.current?.stop();
    captureRef.current = null;
    stopSpeechRef.current?.();
  }

  async function beginSession() {
    setError(null);
    try {
      const useServer = prefs.transcriptSource === 'server' && health?.geminiEnabled;
      const languages = prefs.languages
        .split(/[,\s]+/)
        .map((x) => x.trim().toLowerCase())
        .filter(Boolean);
      const s = await createSession({
        mode: prefs.mode,
        label: prefs.label || undefined,
        consent: { speakerAcknowledged: consent.speaker, secondPartyAcknowledged: consent.second },
        languages: languages.length ? languages : undefined,
        expectSpeakers: prefs.expectSpeakers > 1 ? prefs.expectSpeakers : undefined,
      });
      store.reset();
      store.set({ status: 'connecting', sessionId: s.id, label: s.label });

      const handle = await startCapture({
        sessionId: s.id,
        transcriptSource: useServer ? 'server' : 'browser',
        onMessage: onSocketMessage,
        onClose: () => {},
      });
      captureRef.current = handle;

      if (!useServer) {
        if (browserSpeechSupported()) {
          startBrowserTranscription(handle.socket);
        } else {
          store.set({
            notices: [
              ...useConsole.getState().notices,
              'This browser has no speech recognition. Set an API key (GROQ_API_KEY or GEMINI_API_KEY) for server transcription, or use Chrome.',
            ],
          });
        }
      }

      startedAtRef.current = Date.now();
      store.set({ status: 'live' });
      setStep('live');
    } catch (e: any) {
      setError(e.message || 'could not start');
      teardown();
    }
  }

  function startBrowserTranscription(socket: WebSocket) {
    stopSpeechRef.current?.();
    stopSpeechRef.current = startBrowserSpeech({
      onResult: (text, isFinal) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(JSON.stringify({ type: 'transcript', text, isFinal }));
        }
        store.set({ transcriptLive: isFinal ? '' : text });
      },
      onError: (e) => store.set({ notices: [...useConsole.getState().notices, e] }),
    });
  }

  function onSocketMessage(msg: any) {
    if (msg.type === 'tick') {
      store.set({ snapshot: msg.snapshot, energy: msg.energy, transcribing: Boolean(msg.transcribing) });
    } else if (msg.type === 'transcript' && msg.source === 'server') {
      store.set({ transcriptLive: '' }); // transcript text arrives via the next tick snapshot
    } else if (msg.type === 'transcription-fallback') {
      store.set({ notices: [...useConsole.getState().notices, msg.message] });
      const sock = captureRef.current?.socket;
      if (sock && browserSpeechSupported()) startBrowserTranscription(sock);
    } else if (msg.type === 'notice') {
      store.set({ notices: [...useConsole.getState().notices, msg.message] });
    } else if (msg.type === 'ended') {
      exportRef.current = msg.export;
    }
  }

  function markQuestion() {
    const sock = captureRef.current?.socket;
    if (sock?.readyState === WebSocket.OPEN) {
      sock.send(JSON.stringify({ type: 'question', label: `Q${(store.snapshot?.timeline.filter((t) => t.kind === 'question').length ?? 0) + 1}` }));
    }
  }

  async function endSession() {
    store.set({ status: 'ended' });
    setStep('ended');
    setFinalizing(true);
    stopSpeechRef.current?.();

    // Let the backend transcribe the trailing audio before we snapshot.
    let finalExport: any = null;
    try {
      finalExport = await (captureRef.current?.finish(8000) ?? Promise.resolve(null));
    } catch {
      /* fall back to the last live snapshot */
    }
    captureRef.current = null;
    setFinalizing(false);

    const snap = finalExport?.finalSnapshot ?? useConsole.getState().snapshot;
    if (snap) store.set({ snapshot: snap });

    const entry: HistoryEntry = {
      id: store.sessionId || crypto.randomUUID(),
      label: store.label || 'Session',
      mode: prefs.mode,
      savedAt: Date.now(),
      durationMs: snap?.elapsedMs ?? Date.now() - startedAtRef.current,
      summary: {
        wordCount: snap?.transcript.wordCount ?? 0,
        paceWpm: snap?.pace.wpm ?? null,
        pauseCount: snap?.pauses.count ?? 0,
        fillersPerMin: snap?.fillers.hardPerMin ?? null,
        variety: snap?.vocabulary.variety ?? null,
      },
      export: {
        finalSnapshot: snap,
        timeline: finalExport?.timeline ?? snap?.timeline ?? [],
        transcript: snap?.transcript.text ?? '',
      },
    };
    exportRef.current = entry;
    try {
      saveHistory(entry);
    } catch {
      /* localStorage might be full/blocked */
    }
  }

  async function getCoaching() {
    if (!store.sessionId) return;
    setCoaching({ notes: '', loading: true, error: null });
    try {
      const r = await fetchCoaching(store.sessionId);
      setCoaching({ notes: r.notes, loading: false, error: null });
    } catch (e: any) {
      setCoaching({ notes: '', loading: false, error: e.message });
    }
  }

  async function getIntegrity() {
    if (!store.sessionId) return;
    setIntegrity({ data: null, loading: true, error: null });
    try {
      const r = await fetchIntegrityAnalysis(store.sessionId);
      setIntegrity({ data: r, loading: false, error: null });
    } catch (e: any) {
      setIntegrity({ data: null, loading: false, error: e.message });
    }
  }

  const serverAvailable = Boolean(health?.geminiEnabled);

  /* ----------------------------- render ----------------------------- */

  if (step === 'setup') {
    return (
      <Shell>
        <h1 className="text-2xl font-bold">Start a session</h1>
        <p className="mt-1 text-sm text-white/50">
          ShadowADJ shows how an answer <em>sounds</em> — pace, pauses, filler words, vocabulary variety.
          It never scores the speaker or guesses whether an answer was AI-assisted.
        </p>
        {error && <Banner tone="rose">{error}</Banner>}

        <div className="mt-6 grid gap-3 sm:grid-cols-3">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => setPrefs((p) => ({ ...p, mode: m.id }))}
              className={`glass p-4 text-left transition ${prefs.mode === m.id ? 'ring-2 ring-cyan/60' : 'opacity-80 hover:opacity-100'}`}
            >
              <div className="font-semibold">{m.title}</div>
              <div className="mt-1 text-xs text-white/45">{m.blurb}</div>
            </button>
          ))}
        </div>

        <label className="mt-5 block">
          <span className="metric-label">Session label (optional)</span>
          <input
            value={prefs.label}
            onChange={(e) => setPrefs((p) => ({ ...p, label: e.target.value }))}
            placeholder="e.g. Round 3 — rebuttal practice"
            className="mt-1 w-full rounded-xl border border-stroke bg-black/30 px-3 py-2 text-sm outline-none focus:border-cyan/50"
          />
        </label>

        <div className="mt-5 grid gap-3 sm:grid-cols-[1fr_auto]">
          <label className="block">
            <span className="metric-label">Languages spoken (optional)</span>
            <input
              value={prefs.languages}
              onChange={(e) => setPrefs((p) => ({ ...p, languages: e.target.value }))}
              placeholder="e.g. en, hi — leave blank for English"
              className="mt-1 w-full rounded-xl border border-stroke bg-black/30 px-3 py-2 text-sm outline-none focus:border-cyan/50"
            />
          </label>
          <label className="block">
            <span className="metric-label">Speakers</span>
            <input
              type="number"
              min={1}
              max={8}
              value={prefs.expectSpeakers}
              onChange={(e) => setPrefs((p) => ({ ...p, expectSpeakers: Math.max(1, Number(e.target.value) || 1) }))}
              className="mt-1 w-20 rounded-xl border border-stroke bg-black/30 px-3 py-2 text-sm outline-none focus:border-cyan/50"
            />
          </label>
        </div>
        <p className="mt-1 text-xs text-white/40">
          Naming a non-English language (or more than one speaker) switches transcription to
          multilingual mode — the original is kept, with an English gloss available for judges.
        </p>

        <div className="mt-5">
          <span className="metric-label">Transcription</span>
          <div className="mt-2 flex gap-2">
            <Toggle
              active={prefs.transcriptSource === 'server'}
              disabled={!serverAvailable}
              onClick={() => serverAvailable && setPrefs((p) => ({ ...p, transcriptSource: 'server' }))}
            >
              Server AI {health?.provider ? `(${health.provider} - ${health.model || ''})` : health?.model ? `(${health.model})` : ''}{!serverAvailable && ' — no key set'}
              {serverAvailable && ' · recommended'}
            </Toggle>
            <Toggle active={prefs.transcriptSource === 'browser'} onClick={() => setPrefs((p) => ({ ...p, transcriptSource: 'browser' }))}>
              Browser Web Speech
            </Toggle>
          </div>
          <p className="mt-1.5 text-xs text-white/40">
            Server AI transcription runs on the backend and works in any browser. Web Speech is
            Chrome-only and silently does nothing elsewhere (e.g. Opera, Firefox).
          </p>
        </div>

        <div className="mt-5">
          <span className="metric-label">Metrics to show</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {METRIC_KEYS.map((k) => (
              <Toggle
                key={k}
                active={prefs.metrics[k]}
                onClick={() => setPrefs((p) => ({ ...p, metrics: { ...p.metrics, [k]: !p.metrics[k] } }))}
              >
                {k}
              </Toggle>
            ))}
          </div>
        </div>

        <button className="btn btn-primary mt-7" onClick={() => setStep('consent')}>
          Continue to consent →
        </button>
      </Shell>
    );
  }

  if (step === 'consent') {
    return (
      <Shell>
        <h1 className="text-2xl font-bold">Consent</h1>
        <div className="glass mt-4 space-y-3 p-5 text-sm text-white/70">
          <p>During this session ShadowADJ will:</p>
          <ul className="list-disc space-y-1 pl-5 text-white/60">
            <li>capture microphone audio and stream it to the local backend for analysis;</li>
            <li>show live metrics and a transcript on this screen — the same screen everyone in the room sees;</li>
            <li>keep audio in memory only and discard it when the session ends (no audio file is written).</li>
          </ul>
          <p className="text-white/60">
            It will <strong>not</strong> produce a risk score, a “review” verdict, or an estimate of whether
            answers were AI-assisted.
          </p>
        </div>

        {error && <Banner tone="rose">{error}</Banner>}

        <label className="mt-5 flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1" checked={consent.speaker} onChange={(e) => setConsent((c) => ({ ...c, speaker: e.target.checked }))} />
          <span>
            I am the person being recorded (or I am setting this up on their behalf with their agreement), and
            I consent to this session. <span className="text-rose">Required.</span>
          </span>
        </label>
        <label className="mt-3 flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1" checked={consent.second} onChange={(e) => setConsent((c) => ({ ...c, second: e.target.checked }))} />
          <span>A coach / interviewer is also present and has acknowledged the above. (Optional)</span>
        </label>

        <div className="mt-7 flex gap-3">
          <button className="btn" onClick={() => setStep('setup')}>
            ← Back
          </button>
          <button className="btn btn-primary disabled:opacity-40" disabled={!consent.speaker} onClick={beginSession}>
            Grant mic &amp; start
          </button>
        </div>
      </Shell>
    );
  }

  // live + ended share the dashboard chrome
  const snap = store.snapshot;
  return (
    <div className="mx-auto max-w-6xl px-4 py-6">
      <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <span className={`inline-block h-2.5 w-2.5 rounded-full ${step === 'live' ? 'animate-pulse bg-mint' : 'bg-white/30'}`} />
            <h1 className="text-lg font-semibold">{store.label || 'Session'}</h1>
            <span className="font-mono text-sm text-white/40">{clock(snap?.elapsedMs ?? 0)}</span>
          </div>
          <p className="mt-0.5 text-xs text-white/40">
            {MODES.find((m) => m.id === prefs.mode)?.title} · transcript:{' '}
            {snap?.transcript.source === 'server'
              ? `${health?.provider ? health.provider.toUpperCase() : 'Server'}${health?.model ? ` (${health.model})` : ''}`
              : snap?.transcript.source === 'browser'
                ? 'browser Web Speech'
                : '…'}
            {store.transcribing && <span className="ml-1 text-cyan">· transcribing…</span>}
          </p>
        </div>
        <div className="flex gap-2">
          {step === 'live' && (
            <>
              <button className="btn" onClick={markQuestion}>
                Mark “question asked”
              </button>
              <button className="btn border-rose/40 bg-rose/10 text-rose hover:bg-rose/20" onClick={endSession}>
                End session
              </button>
            </>
          )}
          {step === 'ended' && (
            <>
              {finalizing && <span className="self-center text-xs text-cyan">Finalizing transcript…</span>}
              <button
                className="btn"
                onClick={() => {
                  store.reset();
                  setStep('setup');
                  setCoaching({ notes: '', loading: false, error: null });
                }}
              >
                New session
              </button>
            </>
          )}
        </div>
      </header>

      {store.notices.length > 0 && (
        <Banner tone="amber">{store.notices[store.notices.length - 1]}</Banner>
      )}

      <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
        <div className="glass relative min-h-[340px] overflow-hidden p-0">
          <Sphere analyser={captureRef.current?.analyser ?? null} descriptor={(snap?.pace.descriptor as any) ?? null} live={step === 'live'} />
          <div className="pointer-events-none absolute left-4 top-4 text-xs text-white/45">
            colour = pace ({snap?.pace.descriptor ?? '—'}) · size = live volume
          </div>
        </div>
        <MetricRail snapshot={snap} enabled={{ ...prefs.metrics }} />
      </div>

      <div className="mt-4">
        <Timeline energy={store.energy} snapshot={snap} />
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <div className="glass p-5">
          <h3 className="mb-2 flex items-center gap-2 text-sm font-semibold text-white/80">
            Transcript
            {store.transcribing && <span className="text-[11px] font-normal text-cyan">Gemini transcribing…</span>}
          </h3>
          <div className="max-h-64 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-white/75">
            {snap?.transcript.text || (
              <span className="text-white/30">
                {step === 'live' ? 'Listening… first transcript lands a few seconds in.' : 'No transcript.'}
              </span>
            )}
            {store.transcriptLive && <span className="text-white/35"> {store.transcriptLive}</span>}
          </div>
        </div>

        <div className="glass p-5">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-white/80">Self-review</h3>
            {step === 'ended' && (
              <div className="flex gap-2">
                <button
                  className="btn !px-3 !py-1 text-xs"
                  onClick={() => download(`${store.label || 'session'}.json`, JSON.stringify(exportRef.current, null, 2))}
                >
                  JSON
                </button>
                <button
                  className="btn !px-3 !py-1 text-xs"
                  onClick={() => download(`${store.label || 'session'}.csv`, toCSV(exportRef.current), 'text/csv')}
                >
                  CSV
                </button>
              </div>
            )}
          </div>

          {step !== 'ended' ? (
            <p className="mt-2 text-xs text-white/40">
              Coaching notes become available when you end the session.
            </p>
          ) : serverAvailable ? (
            <div className="mt-3">
              {!coaching.notes && !coaching.loading && (
                <button className="btn btn-primary text-xs" onClick={getCoaching}>
                  Generate coaching notes
                </button>
              )}
              {coaching.loading && <p className="text-xs text-white/50">Thinking through your delivery…</p>}
              {coaching.error && <Banner tone="rose">{coaching.error}</Banner>}
              {coaching.notes && (
                <div className="whitespace-pre-wrap text-sm leading-relaxed text-white/75">{coaching.notes}</div>
              )}
              <p className="mt-3 text-[11px] text-white/35">
                Notes are addressed to you and cover delivery and structure only.
              </p>
            </div>
          ) : (
            <p className="mt-2 text-xs text-white/40">
              Set <code className="text-white/60">GEMINI_API_KEY</code> to enable written coaching notes. Your
              metrics and transcript above are still fully available.
            </p>
          )}
        </div>
      </div>

      {step === 'ended' && (
        <div className="glass mt-4 p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white/80">AI &amp; Plagiarism Integrity Check</h3>
              <p className="text-xs text-white/40">Analyze transcript for plagiarism, external source matching, and AI delivery patterns.</p>
            </div>
            {!integrity.data && !integrity.loading && (
              <button className="btn btn-primary text-xs" onClick={getIntegrity}>
                Run AI &amp; Plagiarism Check
              </button>
            )}
          </div>

          {integrity.loading && <p className="mt-3 text-xs text-cyan">Scanning web corpus &amp; analyzing speech delivery patterns…</p>}
          {integrity.error && <Banner tone="rose">{integrity.error}</Banner>}

          {integrity.data && (
            <div className="mt-4 space-y-3">
              {integrity.data.case ? (
                <>
                  <div className="flex items-center gap-3">
                    <span className="text-xs text-white/60">Risk Level:</span>
                    <span
                      className={`rounded-full border px-2.5 py-0.5 text-xs font-semibold ${
                        integrity.data.case.riskLevel === 'LOW'
                          ? 'border-mint/40 bg-mint/10 text-mint'
                          : integrity.data.case.riskLevel === 'MODERATE'
                            ? 'border-amber/40 bg-amber/10 text-amber'
                            : 'border-rose/40 bg-rose/10 text-rose'
                      }`}
                    >
                      {integrity.data.case.riskLevel} RISK
                    </span>
                    <span className="text-xs text-white/40">
                      Confidence: <strong className="text-white/80">{integrity.data.case.confidence}</strong>
                    </span>
                  </div>

                  {integrity.data.case.signals && integrity.data.case.signals.length > 0 && (
                    <div className="mt-2">
                      <div className="metric-label">Detected Signals</div>
                      <div className="mt-1 flex flex-wrap gap-2">
                        {integrity.data.case.signals.map((sig: any, idx: number) => (
                          <div key={idx} className="rounded-lg border border-white/10 bg-black/25 px-2.5 py-1 text-xs text-white/80">
                            <span className="font-mono text-cyan">{sig.key}</span> ({Math.round((sig.strength || 0) * 100)}% match)
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {integrity.data.case.sourceMatches && integrity.data.case.sourceMatches.length > 0 ? (
                    <div className="mt-3">
                      <div className="metric-label">Matched Sources &amp; Plagiarism</div>
                      <div className="mt-1 space-y-1.5">
                        {integrity.data.case.sourceMatches.map((m: any, idx: number) => (
                          <div key={idx} className="rounded-lg border border-white/5 bg-black/20 p-2 text-xs">
                            <div className="flex justify-between font-medium text-white/80">
                              <span>{m.title || m.domain || 'Source match'}</span>
                              <span className="font-mono text-cyan">
                                {Math.round(m.exactSimilarity * 100)}% similarity ({m.classification})
                              </span>
                            </div>
                            <p className="mt-1 text-white/60 italic">“{m.matchedText}”</p>
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="mt-2 text-xs text-mint/80">✓ No external source plagiarism detected in this transcript.</p>
                  )}
                </>
              ) : integrity.data.analytics ? (
                <div className="text-xs text-white/70">
                  <p className="text-mint">✓ Event policy allows AI assistance — recorded as disclosure analytics.</p>
                  <p className="mt-1 text-white/40">Source matches: {integrity.data.analytics.sourceMatchCount}</p>
                </div>
              ) : (
                <p className="text-xs text-mint">✓ Transcript checked — clear.</p>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------- little bits --------------------------- */

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto max-w-2xl px-4 py-10">{children}</div>;
}

function Banner({ children, tone }: { children: React.ReactNode; tone: 'rose' | 'amber' }) {
  const c = tone === 'rose' ? 'border-rose/40 bg-rose/10 text-rose' : 'border-amber/40 bg-amber/10 text-amber';
  return <div className={`mt-4 rounded-xl border px-4 py-2 text-sm ${c}`}>{children}</div>;
}

function Toggle({
  children,
  active,
  disabled,
  onClick,
}: {
  children: React.ReactNode;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      disabled={disabled}
      onClick={onClick}
      className={`rounded-lg border px-3 py-1.5 text-xs capitalize transition ${
        active ? 'border-cyan/60 bg-cyan/10 text-cyan' : 'border-stroke text-white/55 hover:text-white/80'
      } disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {children}
    </button>
  );
}
