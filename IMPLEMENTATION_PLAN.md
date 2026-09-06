# ShadowADJ — Repository Audit & Implementation Plan

> Response to the *Master Engineering & Product Implementation Specification*.
> Step 1 (audit) and Step 2 (architecture assessment) of the spec's Section 118 process.
> **No production code has been refactored yet** — per the spec's closing instruction.

---

## 0. Honest scope read

The current codebase is **~2,900 lines** across a backend (~950), a frontend (~1,350), and
tests (~200). It does exactly one thing well: take one consenting speaker's live audio and
return descriptive delivery metrics, with zero persistence and one screen.

The specification describes a **multi-role, multi-participant, persistent, adjudicated
competition operating system** — judging engine, integrity/plagiarism engine with external
source search, cross-participant similarity, multilingual + diarization, coaching with
adaptive drills and an AI opponent, multi-judge consensus, replay archive, admin console,
a ~25-entity database, four-role auth, audit logging, a job queue, and cost governance.

That is a **program of work measured in months for a small team**, not a single task. This
document maps the delta, isolates the load-bearing refactors from the feature work, and
proposes a Phase 1 that can start immediately without breaking what works.

Three parts of the spec cannot be built *well* with what's available and are called out
honestly below (Section 6): internet-wide source search, robust diarization, tamper-proof
"secure session" mode. The spec already hedges on all three — the plan builds the
**interfaces** for them now and a real/mock split behind each.

---

## 1. Repository audit (spec §5)

### 1.1 Backend architecture — `backend/src/`

| File | Lines | Responsibility | State |
| --- | --- | --- | --- |
| `index.js` | 300 | Express REST + `ws` server; **all** WS message handling, the transcription pump, chunk/overlap/dedupe logic, broadcast | Doing too much — HTTP routing, transport, orchestration, and a chunk of the transcription algorithm all live here |
| `session.js` | 115 | In-memory `SessionStore` (Map), consent gate, 3 h TTL sweep, optional JSON persist | Sound for what it is; is **not** a durable store and holds live objects (`analyzer`, `clients`) mixed with metadata |
| `config.js` | 47 | `.env` load, model lists (`transcribeModels`, `textModels`), `serverTranscription` flag | Already has a small model-routing seed; no rubric/policy config |
| `gemini.js` | 98 | `generate()` with 404/503 model fallback, `transcribeChunk()`, `coachingNotes()` | The **only** AI call site — good. Prompts are inline; no schema validation, no caching, no token/cost accounting |
| `analysis/analyzer.js` | 336 | `SessionAnalyzer` — streaming VAD consumer, pace/pauses/fillers/vocab/latency, 500 ms snapshot, timeline | Clean, self-contained, well-tested. **This is the reusable core.** Sample-count clock, no wall-time coupling |
| `analysis/metrics.js` | 269 | Pure helpers: `rms`, `tokenize`, `syllables`, `mattr`, `countFillers` (hard/soft + context-gated "like"), `createVad` (rolling-percentile floor, hysteresis, 550 ms hangover), `percentile`, `overlapFraction` | Pure, deterministic, no I/O. Directly reusable and extendable |
| `analysis/metrics.test.js` | 198 | 19 `node:test` cases incl. a guard that no `verdict/risk/cheat/suspicion/authenticity/authorship` string can appear in a snapshot | The enforcement pattern to carry forward |

### 1.2 Frontend architecture — `frontend/src/`

- **Astro 4** static shell, **one** React island (`Console.tsx`, 514 lines, `client:only`).
- Pages: `index` (marketing), `console` (the app), `history`, `about`. All static except the console island.
- `Console.tsx` owns the entire lifecycle state machine: `setup → consent → live → ended`, plus mic capture wiring, WS message handling, coaching fetch, history save, and all rendering.
- Components: `Sphere.tsx` (Three.js FFT icosahedron), `MetricRail.tsx`, `Timeline.tsx`, `History.tsx`.
- `lib/`: `api.ts` (REST fetch), `audio.ts` (AudioWorklet capture + downsample + WS), `speech.ts` (Web Speech fallback), `store.ts` (one `useConsole` Zustand store), `history.ts` (localStorage), `format.ts`.

### 1.3 WebSocket flow

Single socket at `/ws?sessionId=`. Ad-hoc messages, no schema, no version:

```
client → server : {type:"hello", transcriptSource}   binary PCM16 frames
                  {type:"transcript", text, isFinal}  (browser STT mode)
                  {type:"question", label}
                  {type:"end"}
server → client : {type:"ready"|"config"|"tick"|"transcript"|"notice"
                   |"transcription-fallback"|"timeline"|"ended", ...}
```

`tick` carries the full analyzer snapshot + energy timeline every 500 ms.

### 1.4 Transcript pipeline

`AudioWorklet` (mono) → main thread downsample to 16 kHz Int16 → binary WS frames →
`index.js` buffers PCM → every 6–12 s a chunk (with 0.8 s overlap) → `gemini.js`
`transcribeChunk()` → `dedupeJoin()` on the seam → `analyzer.pushTranscript()` →
appears in the next `tick`. Browser Web Speech API is the fallback (Chrome-only) and the
auto-fallback target after 3 consecutive Gemini failures. `flushTranscription()` drains the
tail on `end`.

### 1.5 Gemini integration

`config.gemini` = `{ apiKey, transcribeModels[], textModels[] }`. `transcribeModels` head
`gemini-3.5-flash-lite`; `textModels` head `gemini-3.6-flash`. `generate()` walks the list
on 404/503. Two call sites only: `transcribeChunk`, `coachingNotes`. No structured-output
schema, no retry/repair on malformed JSON (coaching returns prose so it hasn't mattered
yet), no cache, no cost log.

### 1.6 Environment variables

`GEMINI_API_KEY`, `GEMINI_TRANSCRIBE_MODEL`, `GEMINI_MODEL`, `TRANSCRIPTION` (`auto|browser`),
`PORT`, `CORS_ORIGIN`, `PERSIST_TRANSCRIPTS`. `.env` is gitignored; `.env.example` is the
template. **The key currently in `.env` was pasted into chat and is compromised — rotate it.**

### 1.7 Analysis modules

Two: `metrics.js` (pure) and `analyzer.js` (stateful stream consumer). Everything is
descriptive; there is deliberately no scoring, no judgement, no per-person model.

### 1.8 State management

Backend: `SessionStore` Map (volatile). Frontend: one `useConsole` Zustand store
(`status, sessionId, label, snapshot, energy, transcriptLive, transcribing, notices`).
History is browser `localStorage` only.

### 1.9 UI components

`Sphere` (audio-reactive 3D), `MetricRail` (labelled bars), `Timeline` (SVG energy trace +
neutral markers + recent-moments list), `History` (localStorage list + expand + export).
All read from the single store.

### 1.10 Technical debt

1. `index.js` mixes transport, routing, and the transcription algorithm.
2. `Console.tsx` is a 514-line god component (state machine + capture + transport + render).
3. One global store on each side — the spec (§76) explicitly forbids this at target scale.
4. WS messages are unversioned and unschematised (spec §75).
5. AI prompts inline; no structured-output contract or validation (spec §27).
6. No persistence, no entities, no IDs beyond `session.id`.
7. No auth, no roles, no audit log.
8. `session.js` conflates durable metadata with live runtime objects.
9. Analyzer↔transport coupling: the analyzer is reached only through the WS handler.

### 1.11 Duplicated functionality

Minimal. `tokenize`/word-count logic appears in both `metrics.js` and `analyzer.js`
snapshot assembly (acceptable). `history.ts` (frontend) and `session.js` `_persist`
(backend) are two unrelated export paths — will converge on the Storage layer.

### 1.12 Must preserve

- `analysis/metrics.js` + `analysis/analyzer.js` — the **Speech Core** logic. Reuse whole.
- The VAD design (rolling-percentile floor, hysteresis, hangover, blip suppression).
- The transcription pump (chunk / overlap / `dedupeJoin` / end-flush / auto-fallback).
- `audio.ts` capture path (AudioWorklet → 16 kHz Int16 → WS) and `Sphere.tsx`.
- The consent gate (HTTP 403 without `speakerAcknowledged`).
- The "no verdict" snapshot test — and its **pattern**, extended to the new engines.
- `gemini.js` model-fallback behaviour (fold into the AI Gateway, don't discard).

### 1.13 Must refactor

- `index.js` → thin HTTP layer + a WS dispatcher over a typed message schema.
- `session.js` → split runtime session (live objects) from the persisted `Session` entity.
- `Console.tsx` → role-scoped views + hooks; move the state machine out of the component.
- One store → domain stores (spec §76).
- `gemini.js` → `AIGateway` with structured output, validation, retry/repair, cache, cost log.
- `config.js` → model-routing table + Event Policy loader.

### 1.14 Architecture assessment summary

| Target module (spec §6–7) | Current home | Verdict |
| --- | --- | --- |
| **Speech Core** | `analysis/*`, `audio.ts`, transcription pump in `index.js` | **Extract & keep.** Wrap in a `SpeechCore` facade; move the pump out of `index.js` |
| **Session Engine** | `session.js` | **Refactor.** Runtime session vs. `Session` entity; delegate durability to Storage |
| **Event Engine / Policy** | — | **Build.** `Event`, `Round`, `EventPolicy`, `Rubric`, `RubricCriterion` |
| **AI Gateway** | `gemini.js` | **Refactor & expand.** One service, structured JSON, validation, cache, cost |
| **Judge Engine** | — | **Build** (Phase 2). Consumes rubric + transcript + metrics + argument state |
| **Integrity Engine** | — | **Build** (Phase 3–4) behind provider interfaces |
| **Evidence Engine** | `Timeline` (frontend only, ephemeral) | **Build** a persisted, typed evidence/timeline model; the UI already hints the shape |
| **Coach Engine** | `coachingNotes()` in `gemini.js` | **Refactor & expand** (Phase 6) — must consume Judge weaknesses, not free-form |
| **Analytics Engine** | `history.ts` (localStorage) | **Build** server-side over Storage |
| **Storage Layer** | in-memory Map + optional JSON | **Build.** `StorageProvider` iface + SQLite impl |
| **Auth** | — | **Build** minimal (roles + signed tokens) |
| **Audit Logger** | — | **Build** (append-only table + helper) |
| **Search/Source Gateway** | — | **Build interface + mock** now; real provider later |

Roughly: **~40 %** of current code is reusable as-is (Speech Core, capture, sphere),
**~30 %** needs refactoring (session, transport, config, gemini), **~30 %** is UI that a
role-based redesign will largely replace but is a useful reference.

---

## 2. Minimum architectural changes

The load-bearing refactors — everything else in the spec sits on these. Ordered by
dependency. Items **A–D are the minimum**; E–G can trail.

### A. Extract the Speech Core

Move `analysis/` + the transcription pump into `backend/src/speech-core/` with a facade:

```
SpeechCore(sessionId, { sampleRate, transcription })
  .ingestAudio(int16Frame)         // was: ws binary handler + analyzer.pushAudio
  .ingestBrowserTranscript(text, isFinal)
  .markQuestion(label)
  .on('transcript' | 'metrics' | 'timeline' | 'notice', cb)
  .snapshot() / .flush() / .export()
```

`index.js` stops knowing how transcription chunking works. The WS handler becomes:
receive frame → `core.ingestAudio(frame)`; subscribe to `core` events → broadcast.

### B. Typed WebSocket protocol (spec §75)

`shared/ws-protocol.js` (importable by both sides) defining every message as
`{ v: 1, type, ... }` with a validator. A `dispatch(msg)` table replaces the `switch`.
New message types land here, not as another `if`.

```
audio_chunk · transcript_partial · transcript_final · speech_metric
claim_detected · argument_update · judge_update · integrity_event
timer_update · session_status · error
```

### C. Storage layer + core entities (spec §70–71)

`backend/src/storage/StorageProvider.js` (interface) + `SqliteStorage.js`
(`better-sqlite3`, file-backed, zero-infra, Windows-friendly). Phase 1 entities:
`Event, Round, Participant, Session, TranscriptSegment, SpeechMetric, AuditEvent`.
Everything carries `id` + `createdAt`; everything chains back to a `Session` (spec §71).
`SessionStore` keeps only *live* runtime objects, keyed by the persisted `Session.id`.

### D. AI Gateway (spec §26–27, 81–83)

`backend/src/ai/AIGateway.js`:

```
transcribe() · analyzeArgument() · analyzeRebuttal() · judgeCriterion()
generateCoach() · classifySemanticMatch() · summarizeSession()
```

Each method: builds a compact prompt from **structured state, not raw transcript**
(spec §25); requests strict JSON; validates against a schema; on invalid →
retry → repair-prompt → typed fallback (never throws into the request path, spec §27, §73);
writes a cache entry keyed by content hash; logs `{model, inputTokens, outputTokens,
estCost, ms}`. Prompts live in `ai/prompts/` as named templates, one per method.

### E. Config → model routing + policy loader

`config.js` grows `models: { transcribe, judge, coach, similarity, summarize }` (each an
env-overridable ordered list) and an `EventPolicy` loader. Nothing hardcodes a model or a
rubric anywhere else (spec §16, 17, 82).

### F. Frontend state split (spec §76)

`useConsole` → `useSession, useTranscript, useMetrics, useJudge, useIntegrity, useEvent,
useCoach`. Move the `setup→consent→live→ended` machine into a `useSessionMachine` hook.

### G. Role-based routes (spec §77)

`/participant` (today's `/console` live view), `/judge`, `/admin`, `/review`. Astro pages,
each mounting a role island. A dev-only role switcher until auth lands.

---

## 3. The guardrails must be structural, not documentary

The spec's Sections 3, 39, 101, 102, 114, 121 are the product's spine. They must be
enforced the way the current "no verdict" rule already is — by types, API shape, and tests
that fail the build:

- **No numeric AI-usage certainty.** The integrity result type has `riskLevel:
  'LOW'|'MODERATE'|'HIGH'|'CRITICAL'` and no `percent`/`probability` field. A test greps
  the serialised `IntegrityCase` for `%`, `probability`, `confirmed`, `cheat*` and fails on
  a hit (extends `metrics.test.js`'s existing pattern).
- **Performance ≠ integrity.** Separate types, separate storage, separate endpoints. The
  performance score object has no integrity field; combining them requires an explicit
  `EventPolicy.integrityPenalty` rule (spec §101).
- **Human-final.** `IntegrityCase.status` starts `pending_review`; no code path sets
  `confirmed` except the review endpoint, which requires a `reviewerId`. `FinalResult`
  cannot be published while an `IntegrityCase` is `pending_review` unless policy says so.
- **Signal independence (spec §36, §39).** The aggregator takes N *named, independently
  sourced* signals; a config test asserts no single signal weight can produce `HIGH`
  alone.
- **Policy-gated interpretation (spec §97–99).** The Integrity Engine reads `EventPolicy`
  first; with `AI: allowed` it emits analytics rows, never `IntegrityCase`s.
- **UI language (spec §102).** A shared `INTEGRITY_COPY` map is the only source of
  user-facing integrity strings; lint rule bans the raw words in JSX.
- **False-positive suite (spec §105).** Cases A–F become fixture tests that must pass
  before the Integrity Engine ships.

---

## 4. Phased plan (spec §113) with realistic sizing

Sizing is relative effort, not calendar. "⚠" marks work that is partially infeasible with
current tooling — interface now, real implementation gated on an external dependency.

| Phase | Scope | Rests on | Size | Notes |
| --- | --- | --- | --- | --- |
| **1 Foundation** | Refactors A–D + E. Entities Event/Round/Participant/Session/Transcript/SpeechMetric. Existing console keeps working against the new session layer. Tests. | — | **L** | The only phase this document commits to implementing next |
| **2 Judging** | Rubric Engine, Judge Engine, criterion scoring + evidence + confidence, Evidence timeline (persisted), human override, AI-score/human-score split | 1 | **XL** | The core product. Judge Engine is a set of `AIGateway.judgeCriterion` calls over structured argument state |
| **3 Integrity — core** | Exact + fuzzy + semantic matching, common-phrase downweighting, quotation awareness, cross-participant similarity, `IntegrityCase`, risk levels, human review, `SourceSearchProvider` **interface + mock** | 1, 2 | **XL** | ⚠ Real external source search needs a provider key (Exa / Brave / Bing / SerpAPI). Ships with `MockSourceSearchProvider` |
| **4 Integrity — advanced** | Style baseline, preparedness analysis, AI-assistance signal aggregation, session-integrity hashing + anomaly detection, appeals, source graph | 3 | **L** | ⚠ Tamper-*proof* mode is not achievable in a browser (spec §47 concedes this). Deliver: SHA-256 artefact hashing, timestamp-continuity checks, anomaly logging → review |
| **5 Multilingual** | Language detection, native-language transcription, code-switch segmentation, translation-alongside (never translate-before-judge), cross-language similarity | 1 | **M** | ⚠ Diarization is best-effort via the transcription model, flagged low-confidence — no local diarizer is available |
| **6 Coaching** | Weakness extraction *from Judge output*, personalised plans, adaptive drills, AI opponent with session memory, dynamic difficulty, retry + before/after, progress tracking | 2 | **L** | Coach consumes Judge weaknesses verbatim (spec §89) — not generic advice |
| **7 Competition OS** | Admin console, judge rooms, participant management, leaderboard (public status only), multi-judge consensus + variance, tie-break engine, post-event analytics, replay archive, auth + RBAC, audit log surfacing, in-process job queue | all | **XL** | Auth (§79–80) and the queue (§107) may need to move earlier if a real multi-user pilot is scheduled |

---

## 5. Proposed Phase 1 — concrete scope for the next turn

**Goal:** stand up the skeleton the other phases attach to, without regressing the working
speech console.

New / changed files:

```
backend/src/
  shared/ws-protocol.js         NEW  versioned message schema + validator + dispatch()
  speech-core/
    index.js                    NEW  SpeechCore facade (EventEmitter)
    transcription-pump.js       NEW  moved out of index.js (chunk/overlap/dedupe/flush/fallback)
    analyzer.js                 MOVED from analysis/  (unchanged logic)
    metrics.js                  MOVED from analysis/  (unchanged logic)
    metrics.test.js             MOVED
  storage/
    StorageProvider.js          NEW  interface + JSDoc types
    SqliteStorage.js            NEW  better-sqlite3, migrations, CRUD for phase-1 entities
    schema.sql                  NEW
  domain/
    entities.js                 NEW  factory + validators: Event, Round, Participant,
                                     Session, TranscriptSegment, SpeechMetric, AuditEvent
  ai/
    AIGateway.js                NEW  wraps current transcribe/coach; structured output,
                                     validate → retry → repair → fallback; cache; cost log
    prompts/                    NEW  transcribe.js, coach.js (moved from gemini.js)
    schema.js                   NEW  zod-free hand JSON validators
  session.js                    REFACTOR  runtime session ↔ Session entity via Storage
  config.js                     REFACTOR  models: {transcribe,judge,coach,similarity,summarize}
  index.js                      REFACTOR  thin: REST routes + WS dispatch over ws-protocol
  audit.js                      NEW  append AuditEvent helper

frontend/src/
  lib/store.ts                  REFACTOR  split into session/transcript/metrics stores
  lib/ws-protocol.ts            NEW  mirror of shared/ws-protocol message types
  components/Console.tsx        MINIMAL  point at new stores + message types; no UX change
```

New dependency: `better-sqlite3` (backend). No frontend deps.

New env: `DATABASE_URL` (default `file:./data/shadowadj.db`), `SEARCH_PROVIDER` (default
`mock`, unused until Phase 3).

Tests added: entity validators; `StorageProvider` round-trip; `ws-protocol` validation;
`AIGateway` malformed-JSON → repair → fallback (spec §104 "AI" + §27); Speech Core
ingest→snapshot parity with the pre-refactor analyzer output (regression guard).

**Acceptance:** `npm run dev` runs; the console captures, transcribes, and shows live
metrics exactly as today; a `Session` row + its `TranscriptSegment`s + final `SpeechMetric`
persist to SQLite; `npm --workspace backend test` is green; no Gemini failure can crash a
session (kill-the-key test).

---

## 6. Open decisions (need your call before Phase 1 code)

1. **Persistence.** `better-sqlite3` (recommended — zero infra, one file, synchronous, fine
   on Windows) vs Postgres (the spec lists `DATABASE_URL`; needed only for multi-node) vs
   JSON files behind the same interface (fastest to ship, worst at query time).
2. **Backend language.** Migrate `backend/` to **TypeScript** now (a 25-entity domain model
   is painful in plain JS; the spec says "typed where practical") vs stay JS + JSDoc types.
   Frontend is already TS.
3. **Auth timing.** Build minimal role auth in Phase 1 (needed the moment there's a judge
   view) vs stub with a dev role-switcher and do real auth in Phase 7. Depends on whether a
   real multi-user pilot is near.
4. **Repo shape.** Add a third workspace `shared/` for the WS protocol + entity types
   shared by both sides, vs duplicate the small type surface.
5. **Rotate the Gemini key** now exposed in `.env` — confirm you've done this.

---

## 7. Phase 1 — DELIVERED

Decisions taken: **SQLite**, **backend migrated to TypeScript**, **auth stubbed** (Phase 7).

### What shipped

| Area | Detail |
| --- | --- |
| **TypeScript backend** | All `backend/src` is now `.ts`, run directly by Node 25's native type-stripping — **no build step**. `tsconfig.json` with `strict` + `noUncheckedIndexedAccess` + `erasableSyntaxOnly`; `npm --workspace backend run typecheck` is clean. `@types/*` + `typescript` added as dev deps. `analyzer.js` / `metrics.js` stay JavaScript on purpose (pure, 19 passing tests) behind a hand `analyzer.d.ts`. |
| **Storage** | `node:sqlite` (built-in — chosen over `better-sqlite3` to avoid a native compile on Windows). `StorageProvider` interface + `SqliteStorage` + `schema.sql`. Entities: Event, Round, Participant, Session, TranscriptSegment, SpeechMetric, AuditEvent — all with `id` + `createdAt`, all chaining to a Session. `DATABASE_URL` env (`file:./data/shadowadj.db`). |
| **Domain layer** | `domain/types.ts` (+ `EventPolicy`, `DEFAULT_POLICY`) and `domain/entities.ts` (factories + hand validators, `ValidationError`). The consent gate now lives in `createSession()` and still returns **403**. |
| **AI Gateway** | `ai/AIGateway.ts` — the single Gemini call site. Model-routing table from `config`; 404/503 fallback; **JSON methods validate → repair-retry → typed fallback, never throw**; content-hash cache; per-call `{model, ms, ok, tokens, estCostUsd}` log exposed at `GET /api/ai/cost`. Prompts moved to `ai/prompts/`. A `_call` test seam replaces the SDK in unit tests. |
| **Speech Core** | `speech-core/` — `SpeechCore` facade (EventEmitter: `transcript` / `timeline` / `fallback`) wrapping the analyzer + the extracted `transcription-pump.ts` (chunk / 0.8 s overlap / `dedupeJoin` / end-flush / 3-failure auto-fallback, byte-for-byte the old behaviour). The WS handler no longer knows how transcription works. |
| **Protocol** | `shared/protocol.ts` — every WS message typed + `parseClientMessage()` validator + `encode()`. **Wire shapes unchanged**, so the frontend needed zero edits. |
| **Session layer** | `session.ts` — `SessionManager` owns runtime sessions (SpeechCore + sockets) keyed by the persisted `Session.id`. Persists transcript segments live, a `periodic` SpeechMetric every 10 s, a `final` one on end. Emits a `TimerState` in every tick (counts down from `EventPolicy.maxDurationSec` when a session is attached to an event). |
| **Thin `index.ts`** | REST (health, `ai/cost`, events + rounds + participants CRUD, sessions, export, audit, end, coaching) + WS dispatch. `gemini.js` and the old `index.js` / `session.js` / `config.js` deleted. |
| **Audit** | `audit.ts` append-only helper; `event.created`, `session.started`, `session.ended`, `transcription.fallback`, `coaching.generated` recorded; `GET /api/sessions/:id/audit`. |
| **Tests** | 44 `node:test` cases (was 19): entity validators, SQLite round-trips + lifecycle, protocol validation, AIGateway repair/fallback/model-walk/cost, SpeechCore parity + the no-verdict guard carried through the refactor. |

### Verified end-to-end

`npm run dev` boots; the existing console (unchanged) captures → Gemini-transcribes → shows the same live metrics (pace 175 wpm "steady", 4 pauses — identical to pre-migration); a `Session` row + 6 `TranscriptSegment`s + a `final` `SpeechMetric` persist to SQLite; the ended session exports from storage; the audit trail and `ai/cost` populate; coaching returns 200; killing the key doesn't crash a session; `tsc --noEmit` and `astro build` both clean.

### Deviations from the plan

- `better-sqlite3` → **`node:sqlite`** (no native build; experimental-flagged, warning suppressed in the run scripts).
- `analyzer.js` / `metrics.js` kept as **JavaScript** (behind a `.d.ts`) rather than migrated — lower risk, zero behaviour change; annotate later.
- Frontend state split (item F) **deferred to the Phase 2 opener** — keeping the wire protocol byte-compatible meant the frontend needed no change at all, and splitting the 514-line `Console.tsx` store now carried avoidable regression risk.

### Not started after Phase 1 (Phases 2–7)

Judge Engine, Integrity Engine, Evidence layer, multilingual, Coach Engine expansion, competition OS, real auth, source search. The seams are in place: `AIGateway` reserves the `judge` / `similarity` / `summarize` model slots, `EventPolicy` is stored and read, the entity + audit + protocol layers are ready to extend.

---

## 8. Phase 2 — Judging — DELIVERED (backend + a read/write judge view)

### What shipped

| Area | Detail |
| --- | --- |
| **Rubric Engine** | `domain/rubrics.ts` — `createRubric` + hand validators, weights accept fractions **or** percentages (spec §17) and normalise to sum 1, per-criterion 1–10 scale with default anchors (spec §18). Four presets (`debate`, `interview`, `speech`, `hackathon-pitch`, spec §68). `rubrics` table + CRUD; `GET /api/rubrics/presets`, `POST /api/rubrics`, `GET /api/rubrics[/:id]`, `PUT /api/events/:id/rubric` (attach by id or spin up from a preset). |
| **Evidence timeline** | `TimelineEvent` entity + `timeline_events` table (spec §21) — typed, persisted, `severity` (info/notable/concern) + `confidence` + `source` (speech-core / judge / integrity). The `SessionManager` mirrors the analyzer's neutral markers (question / pause / long-pause / pace-shift) into it every 10 s and on end; the Judge Engine appends `strong-moment` / `weakness` markers from its evidence. `GET /api/sessions/:id/timeline`. |
| **Judge Engine** | `judge-engine/` — `evaluate({ session, rubric })` runs one `AIGateway.judgeCriterion` per criterion → `{ score, confidence, evidence[{startMs,endMs,quote,reason}], strengths[], weaknesses[], reasoning }`, never a bare number (spec §19, §20). Weighted `overallScore`; `overallConfidence` drops to *low* if any ≥20%-weight criterion is low. Context is the segmented transcript + a metrics digest + the timeline digest — **not audio, not repeated whole-transcript spam** (spec §25). |
| **Confidence guard** | `judge-engine/confidence.ts` (spec §93) — a deterministic layer that can only *lower* the model's self-reported confidence, with a stated reason: `<40` words → low, `<120` → medium, `<20 s` speaking → medium, zero evidence → low, AI call failed → low. |
| **Human override / hybrid** | `PATCH /api/evaluations/:id/criteria/:criterionId` sets a `humanScore`, keeps `aiScore`, recomputes the overall, flips `judgeType` to `human` (spec §50, §94). `POST …/finalize` (blocked while any criterion has neither an AI nor a human score), `POST …/reopen`. Every step audited: `evaluation.created` / `override` / `finalized` / `reopened`. |
| **AI Gateway** | `judgeCriterion()` added — structured JSON, score clamped to the criterion scale, validate → repair → **typed `evaluated:false` fallback** so a bad model reply becomes "needs a human score", never a fake number or a thrown error. Prompt in `ai/prompts/judge.ts` explicitly bars any comment on outside assistance (spec §101). |
| **Judge view** | `frontend/pages/judge.astro` + `JudgeView.tsx` — read/write, opens as `/judge?session=<id>`. Runs an evaluation, shows every criterion's score / confidence pill / confidence-limits / reasoning / strengths / weaknesses / timestamped evidence quotes, an "AI n → human m" line on overrides, the evidence timeline, and a "Finalise / Reopen" control. Inline "Adjust" prompts for a human score + reason. Matches the existing dark-glass style; no store changes. |
| **Tests** | 57 `node:test` cases (was 44): rubric normalisation + presets, `judgeCriterion` clamp + fallback, the full evaluate → guard → override → finalize → reopen path with a mocked model, and a guard asserting a `JudgeEvaluation` never serialises `%` / `probability` / `cheat` / `plagiar` / `integrity` / `verdict` (performance ≠ integrity, spec §101). |

### Verified end-to-end (real Gemini)

`POST /api/events` → `PUT …/rubric {preset:'debate'}` → session on the event → audio → `POST /api/sessions/:id/evaluations` runs 6 real `judgeCriterion` calls → per-criterion score + evidence + reasoning, the confidence guard correctly caps a thin (18-word) transcript to *low* on every criterion with the reason shown → `PATCH` override (AI 1 → human 9, `aiScore` kept, overall 1.3 → 3.7, `judgeType` → human) → `finalize` → audit trail `evaluation.created/override/finalized`, `GET /api/ai/cost` shows 10 calls / ~$0.001. The `/judge` page renders the finalised evaluation from storage.

### Deferred to Phase 2b / later

Multi-judge consensus + variance (spec §49), tie-break engine (§51), the frontend Zustand store split (item F above), a live in-round judge dashboard, the argument graph / claim extraction (§22–24), STAR detection and interview cross-answer consistency (§65–67). The rubric, evaluation, timeline and audit layers all extend to carry these.

---

## 9. Phase 3 — Integrity (core) — DELIVERED (backend + a `/review` view)

Integrity is a **separate concept from performance** (spec §2, §101). Nothing in this
phase feeds a score. The output is a risk **level** + evidence + reason + recommended
action — never a probability, never "AI use = N%". Only a named human reviewer can move a
case to `confirmed`.

### What shipped

| Area | Detail |
| --- | --- |
| **Text primitives** | `integrity/text.ts` — sentence segmentation, word-3-gram shingling, containment/Jaccard similarity, common-phrase filtering (spec §30, anchored to sentence starts), distinctive-phrase extraction (spec §29), attribution detection, quotation classification (original / copied / quoted / paraphrased / common-knowledge / attributed / uncertain, spec §33). Deterministic — no AI. |
| **Source search** | `SourceSearchProvider` interface (spec §84) + `MockSourceSearchProvider` — ranks a 6-doc seeded corpus by shingle overlap, seedable for a demo (spec §119). `coverageNote` says honestly "not a live web search" (spec §86). Domain → source-type → credibility table (academic 0.95 … social 0.2, spec §34). A real provider drops in via `SEARCH_PROVIDER` + a key. |
| **Signal aggregation** | `integrity/signals.ts` (spec §36, §39) — independent signals in, a risk **LEVEL** out. Weights on a 0–100 internal scale, tilted by `EventPolicy` (§97–99). **Per-origin contribution cap (35):** all facets from one origin together top out at MODERATE; HIGH needs a second independent origin. Confidence rises with corroborated signals from independent origins. |
| **Integrity Engine** | `integrity/index.ts` — `analyzeSession()` runs source matching + cross-participant similarity (other sessions in the same event, spec §32) → four signals → aggregate → **policy gate:** `aiAssistance: 'allowed'` → an `IntegrityAnalytics` row and **no case** (spec §97); otherwise an `IntegrityCase` at `pending_review`. `review()` requires a `reviewerId`, requires a `reason` to `confirm`, and is the **only** path that can set `confirmed` (spec §42). |
| **Entities + storage** | `IntegrityCase` + `IntegrityAnalytics`, two tables + CRUD. The case type has **no** `score` / `probability` / `percent` / `rubricId` field. |
| **Copy** | `integrity/copy.ts` — the single source of user-facing integrity wording (spec §102). Risk labels, per-level recommendations, the "what this does not establish" disclaimer, decision labels, public-vs-private status map (spec §88). |
| **REST** | `POST/GET /api/sessions/:id/integrity`, `GET /api/events/:id/integrity`, `GET /api/integrity-cases/:id`, `POST /api/integrity-cases/:id/review`. |
| **Review view** | `frontend/pages/review.astro` + `ReviewView.tsx` — `/review?session=<id>` / `?event=<id>` / `?case=<id>`. Risk chip, signals with strength bars + origins + evidence, source matches (domain, type, credibility, % word-overlap, quotation class, honest coverage line), cross-participant overlap, the "what this does NOT establish" box, and a decision form that requires a reviewer id (and a reason to confirm). |
| **Tests** | 84 `node:test` cases (was 57). Includes the **spec §105 false-positive suite** (Cases A–F) and structural guards: no `probability`/`percent`/`internalScore` in a case, only `review()` sets `confirmed`, `reviewerId` required, policy-gate → analytics-not-case. |

### Verified end-to-end

Two sessions in one event, both quoting a seeded blog post verbatim without attribution →
`POST /api/sessions/:id/integrity` → **risk HIGH, confidence high** (source-search signals ×3 +
cross-participant) → `review` without `reviewerId` → **400**; with one → status `investigating`,
audit `integrity.case.created` / `integrity.case.reviewed`; `/review` renders it. A *paraphrased*
(not copied) transcript correctly returns **LOW** — shingle matching is deliberately exact-ish.

### Deferred (Phase 3b / 4)

Semantic/embedding paraphrase matching and the Gemini "high-value ambiguous pair" pass (spec §31),
a real web search provider, the source graph (spec §62), the originality heatmap (spec §35),
appeals (spec §43). Phase 4: style baseline, preparedness analysis, session-integrity hashing +
tamper detection (spec §37–39, §44–46).

---

## 10. Phase 4 — Integrity (advanced) — DELIVERED

All new evidence here is deliberately **weak and corroborating** — style, preparedness
and session anomalies point a human toward review, never toward a verdict.

### What shipped

| Area | Detail |
| --- | --- |
| **Style baseline** | `integrity/style.ts` (spec §37) — a per-speaker baseline from their **own** prior sessions (≥3 required; sessions under 40 words excluded). Six metrics (sentence length, vocabulary variety, longer-word rate, filler rate, pause rate, pace) → per-metric z-scores + an `overallShift`. Reasons only for metrics ≥2σ off the speaker's norm. Carries an explicit `caveat` that speech-to-text distorts every one of these measures. Persisted as `StyleBaseline`. |
| **Preparedness** | `integrity/preparedness.ts` (spec §38) — classifies delivery as spontaneous / prepared / highly-rehearsed / uncertain from hesitation rate, pause rate, talk ratio, pace steadiness and vocabulary consistency. It is an **observation**, not a signal, and every payload carries the note *"Preparation is not evidence of unauthorised assistance."* |
| **Session integrity** | `integrity/session-integrity.ts` (spec §44–46). On session end the `SessionManager` SHA-256-hashes the ordered transcript, the final snapshot and the timeline into a `SessionArtifacts` row. `checkSessionIntegrity` re-hashes and diffs, and scans for timestamp discontinuity, duplicated segments, timing inconsistent with audio, mid-session reconnects and audio-stream gaps. Every finding is an **anomaly** with a severity — never "tampered" — and the report states honestly that *"browser-based capture cannot be made tamper-proof"* (spec §47). |
| **Signal aggregation** | `signals.ts` extended with three low-weight signals — `style-discontinuity` (weight 10, origin `style-baseline`), `session-integrity-anomaly` (14, `session-integrity`), `preparedness-under-prohibition` (8, `preparedness`). The per-origin cap and "no single origin → HIGH" rule still hold; **`preparedness-under-prohibition` only fires when the event prohibits prepared material AND another signal is already present** (spec §38, §101). |
| **Appeals** | `IntegrityAppeal` entity + `POST /api/integrity-cases/:id/appeal` (participant statement + optional source attribution) and `POST /api/integrity-appeals/:id/respond` (`upheld` clears the case, `partially-upheld` → monitoring; **an appeal can never move a `confirmed` case**). Both audited. A participant-facing `GET /api/integrity-cases/:id/participant-view` returns the evidence against them **without** internal signal weights or other participants' identities (spec §43, §79). |
| **Source graph** | `integrity/graph.ts` (spec §62) + `GET /api/integrity-cases/:id/graph` — the submission at the centre, weighted edges to each external source domain and each overlapping submission. Pure view, no new storage. |
| **Storage** | New tables `style_baselines`, `session_artifacts`, `integrity_appeals`; `integrity_cases` gains `participant_id`, `style_analysis`, `preparedness`, `session_integrity` (with an idempotent `ALTER TABLE` migration for existing DBs). |
| **Review view** | `ReviewView.tsx` extended — style-vs-baseline shift + reasons + caveat, the preparedness observation, session-integrity anomalies (colour-coded) + the honest note, a collapsible source-graph edge list, and an appeals panel with an inline reviewer response form. |
| **Tests** | 103 `node:test` cases (was 84): style baseline thresholds + deviation + caveat, preparedness classification, artefact-hash determinism + tamper detection + anomaly wording, and engine-level checks that style never escalates alone, "prepared ≠ AI" (no signal with notes allowed, none without a second signal), an appeal clears a case but not a confirmed one, the participant view redacts weights and names, and Phase 4 fields smuggle no `probability` / `score` into a case. |

### Verified end-to-end

Two verbatim-quoting sessions in a `preparedNotes: prohibited` event → `POST /integrity`
→ HIGH with the four source/cross signals; `preparedness` recorded as an observation
("prepared", rehearsedScore 0.55) with **no** `preparedness-under-prohibition` signal
(below threshold — "prepared ≠ AI" holds); `sessionIntegrity` hashed, no anomalies;
`GET /artifacts` returns the transcript hash; `GET .../graph` returns 3 nodes / 2 edges;
an appeal → `partially-upheld` moves the case `pending_review → monitoring`;
`participant-view` contains no `strength` or `otherLabel`. Audit:
`integrity.case.created`, `integrity.appeal.submitted`, `integrity.appeal.responded`.

### Deferred

Semantic/embedding paraphrase matching (Phase 3b), a real web search provider, an
interactive graph rendering, prompt-like-language detection and authorship-consistency
signals (spec §36 signals 6 & 8), the secure-session mode (spec §47 — honestly limited).

---

## 11. Phase 5 — Multilingual — DELIVERED

The ORIGINAL transcript stays authoritative everywhere. Translation is added
alongside, never in place (spec §12). Code-switching is described, not scored —
Event Policy decides if a language matters (spec §13). Diarization is best-effort
from the transcription model and always flagged low-confidence (spec §14).

### What shipped

| Area | Detail |
| --- | --- |
| **Structured transcription** | `AIGateway.transcribeStructured()` — JSON out, `{ utterances: [{ text, lang, speaker }] }`, validate → repair → `[]` fallback. The pump runs it when the session (or its event) names a non-English language or expects >1 speaker (`MULTILINGUAL=auto\|always\|off`). Each finalised delta carries the chunk's dominant language + latest speaker tag; `TranscriptSegment.lang` / `.speakerId` (columns that existed since Phase 1) are now populated. English-only sessions keep the plain fast path unchanged. |
| **Language profile** | `i18n/language.ts` — `languageSpans` merges consecutive same-language segments; `languageProfile` reports per-language share, span count, `switches`, `codeSwitching`, and `outsidePolicy` (languages spoken that the event doesn't list — **a note, not a flag**). `GET /api/sessions/:id/language`. |
| **Language-aware fillers** | `i18n/fillers.ts` — small hard-hesitation lexicons for hi / es / fr / de / pt alongside the English set (spec §9); chosen by the segment's detected language. |
| **Translation-alongside** | `AIGateway.translate()`. `GET /api/sessions/:id/transcript?translate=en` returns every segment as `{ text (original, unchanged), lang, translation, speakerId }`. A segment already in the target language gets `translation: null` (no wasted call). |
| **Judge gloss (never translate-before-judge)** | When the answer isn't primarily English, `JudgeEngine.evaluate` fetches one English gloss and passes it to the prompt **labelled reference-only**, with the original marked authoritative and an instruction not to mark the answer down for its language or judge the translation's phrasing (spec §12). |
| **Cross-language source matching** | The Integrity Engine translates a non-English transcript once, matches the translation against the (English) corpus, and stamps every resulting `SourceMatch` with `viaTranslation: true` and significance ×0.7 (translation uncertainty, spec §12). `atMs` is dropped on translated matches (timestamps don't survive translation). |
| **Diarization** | Transcription speaker tags → stable per-session ids; `GET /api/sessions/:id/speakers` returns `{ speakers: [{ id, label, segmentCount, speakingMs, turns }], confidence: 'low', note }`. |
| **Frontend** | Console setup gains "Languages spoken" + "Speakers" inputs (wired to session create). A shared `LanguageLine` component shows a descriptive one-liner (primary language, code-switching + transition count, languages outside policy) on the `/judge` and `/review` views. |
| **Tests** | 114 `node:test` cases (was 103): span merging + profile + code-switch + outside-policy note + filler-lexicon-by-language; the multilingual pump emits deltas with dominant-lang + speaker meta and repairs a malformed structured reply; a non-English answer is source-matched `viaTranslation` at reduced significance; the judge prompt carries the gloss + "original is authoritative"; and the language profile stays purely descriptive (no `violation` / `penalty` field). |

### Verified end-to-end (real Gemini)

Session with `languages: ['en','hi']`, `expectSpeakers: 2` → structured transcription
engaged; 6 segments transcribed verbatim with `lang: 'en'`, `speakerId: 'spk_1'`;
`/language` → monolingual English profile; `/speakers` → one speaker, `confidence: low`,
33 s speaking; `/transcript?translate=en` → `translation: null` for the already-English
segments. Non-English translation, code-switch and gloss paths are covered by unit tests
with mocked/seeded AI (no local non-English TTS voice available to record a real clip).

### Deferred

Per-word language boundaries (chunk-granularity today), a real diarizer, romanised-vs-native
script normalisation, and translating the integrity source-match evidence quotes back for
display. Phase 6 is the Coach Engine expansion (drills, AI opponent, retry + before/after).

---

## 12. Phase 6 — Coaching — DELIVERED

Coaching consumes the Judge Engine's **exact** weaknesses — quoted verbatim, not
re-generated (spec §89). Personas change wording only, never a score, a weakness
or a drill choice (spec §59). Nothing here produces an integrity signal.

### What shipped

| Area | Detail |
| --- | --- |
| **Coach plan** | `CoachEngine.plan()` pulls every `CriterionScore.weaknesses[]` string from the latest evaluation **byte-for-byte**, attaches the criterion's evidence, maps each to a drill (`coach/drills.ts` — an inspectable keyword rule, e.g. *"failed to engage the opponent" → rebuttal-sprint*), and picks the 1-3 lowest-scoring criteria as `focusAreas`. One Gemini call turns the *given* weaknesses into a short practice `summary` + `keepDoing` list in the chosen persona's voice; if the model is unavailable it degrades to a typed fallback. |
| **Personas** | `coach/personas.ts` — supportive / analytical / strict / executive / debate-coach / interview-coach (spec §59). They only shape the summary prompt. |
| **Adaptive drills** | 9 drill types (spec §56) with a catalogue (label, goal, time limit). `startDrill()` generates the drill prompt via Gemini (deterministic catalogue fallback on failure). A drill's *response* is recorded as its own ShadowADJ session (`responseSessionId`), so the whole speech/judge pipeline applies. `gradeDrill()` runs a focused single-criterion pass → `{ score, targetMet, feedback }` and computes `suggestedNextDifficulty` (`nextDifficulty` — step up when the target is met with margin, ease when missed badly, spec §58). |
| **AI opponent** | `opponentTurn()` (spec §57) — configurable difficulty / aggression / domain / style / language; appends `{ participant, opponent }` turns to `drill.exchanges` so **each turn sees the whole exchange** (session memory). Degrades gracefully. |
| **Retry / before-after** | `compare({ beforeSessionId, afterSessionId })` (spec §91) — per-criterion and per-metric (wpm, filler rate, pauses, talk ratio, vocabulary variety) `{ before, after, delta }` drawn straight from the two sessions' stored evaluations and final snapshots. No fabricated numbers. |
| **Progress** | `progress(participantId)` (spec §90, §92) — a time-ordered series of `{ overallScore, wpm, fillerPerMin, pausePerMin, vocabularyVariety }` over **only that participant's own** ended sessions, plus a first→last trend. |
| **Storage / REST** | `coach_plans`, `drills` tables + CRUD. `POST /api/sessions/:id/coach/plan`, `GET /api/coach-plans/:id`, `POST /api/coach-plans/:id/drills`, `POST /api/drills/:id/{response,grade,opponent}`, `POST /api/coach/compare`, `GET /api/participants/:id/progress`. Every step audited (`coach.plan.created`, `coach.drill.started`, `coach.drill.graded`). |
| **Frontend** | `frontend/pages/coach.astro` + `CoachView.tsx` (`/coach?session=<id>` or `?plan=<id>`) — persona picker + build; overall score, focus areas, summary, keep-doing; each verbatim weakness with its evidence and a "Start <drill>" button; an inline drill card with the AI-opponent exchange, grade + next-difficulty; a before/after compare panel and a progress trend line. Nav link added. |
| **Tests** | 127 `node:test` cases (was 114): weakness→drill mapping and adaptive-difficulty rules; and the engine guards — **plan weaknesses are byte-identical to the source evaluation**, persona changes only the summary, no evaluation → 422, an all-strong evaluation yields no weaknesses + keepDoing, drill start→attach→grade with adaptive difficulty + audit, AI-opponent memory across turns, before/after deltas with no invented numbers, progress is participant-scoped, and a coach plan carries no `risk`/`integrity`/`probability` field. |

### Verified end-to-end (real Gemini)

A judged debate session → `POST /coach/plan` (persona `debate-coach`) → **verbatim check
PASS** (every plan weakness string equals a Judge `weaknesses[]` entry), 6 weaknesses each
mapped to a drill; `focusAreas` = the three lowest criteria. `startDrill` and `opponentTurn`
verified against the running server; grading and the compare/progress endpoints covered by
unit tests. (The Gemini free-tier quota was hit mid-run from cumulative phase testing — the
engine degraded to typed fallbacks throughout, exactly as designed.)

### Deferred

Replay Theater (spec §60 — a UI over existing timeline/transcript/score data), a fully
automated retry loop, coaching in a non-English persona's language end-to-end. That closes
the plan's Phases 1-6; Phase 7 is the Competition OS (admin, judge rooms, leaderboard,
multi-judge consensus, tie-break, auth + RBAC, job queue).

---

## 13. Phase 7 — Competition OS — DELIVERED

The multi-user layer: real auth + RBAC, multi-judge consensus, a deterministic
tie-break engine, a public/admin leaderboard split, post-event analytics, a replay
archive bundle, event-wide audit surfacing and an in-process job queue. Performance
and integrity stay separate throughout — consensus and analytics never read a risk
level into a score, and the public leaderboard carries a status **label** only
(spec §53, §88, §101).

### What shipped

| Area | Detail |
| --- | --- |
| **Auth** | `auth/hash.ts` — password hashing with Node's built-in **scrypt** (`scrypt$N$salt$dk`), salted, `timingSafeEqual`, no dependency. `auth/tokens.ts` — stateless **HMAC-SHA256** signed tokens, format `base64url(payload).base64url(sig)`, 12 h TTL, tamper/expiry checked. `auth/users.ts` — `User` entity, `createUser` (password ≥ 8), `publicUser` strips the hash. `users` table + full CRUD on `SqliteStorage`. |
| **RBAC** | `auth/middleware.ts` — role reach **admin > reviewer > judge > participant** (`roleSatisfies`). `requireRole(storage, need)` middleware → 401 unauthenticated / 403 under-privileged. **Dev mode**: with `AUTH_SECRET` unset every request runs as a synthetic admin, so the console and the whole existing test surface keep working untouched. Set `AUTH_SECRET` to enforce. The **first** account registered on a fresh server bootstraps as `admin`; after that only an admin can mint a non-participant role. |
| **Routes gated** | `/api/auth/{register,login,logout,me,users}`. Judge role: evaluation override/finalize/reopen, `/consensus`, `/tiebreak`, `/replay`, all `/api/jobs*`. Reviewer role: integrity `review` / appeal `respond`, `/analytics`. Admin role: `/api/events/:id/audit`, `/api/auth/users`. Public (open): session create + WS, participant-view of a case, `leaderboard?view=public`. |
| **Multi-judge consensus (§49)** | `competition/consensus.ts` — combines every `JudgeEvaluation` for one session into per-criterion mean / min / max / spread / stddev and an overall agreement label (`strong` / `moderate` / `weak`). Flags `divergentCriteria` (judges differ by > 20 % of scale) and `outlierJudges`. **Never reads integrity.** A guard test asserts no `risk` / `integrity` / `probability` / `percent` string can appear in its output. |
| **Tie-break engine (§51)** | `competition/tiebreak.ts` — deterministic ordered rules: overall score → configurable criterion priority → least judge disagreement → most human review. Every tie it breaks records **the exact rule that broke it** and a human-readable `trace`. No randomness — if the rules run out the entries **share a rank** and that is stated (never a silent coin flip). |
| **Leaderboard (§53, §88)** | `competition/leaderboard.ts` — one computation, two views. **Public**: rank, name, score, `integrityStatus` ∈ {`clear`, `under-review`} — and *nothing else about integrity*: no risk level, no signal, no spread, no judge name. **Admin**: adds judge count, consensus spread, agreement, internal risk level and open case ids. A guard test greps the public payload for `HIGH`/`CRITICAL`/`riskLevel`/`signals`/`consensusSpread` and fails if any appear. |
| **Post-event analytics (§63)** | `competition/analytics.ts` — score distribution (mean / median / stddev / 5-bucket histogram over per-session consensus), criterion averages, **judge calibration** (mean score given and mean deviation from the rest of the room — `+` generous, `−` harsh, an instrument not a verdict), and an integrity summary that is **counts by risk and status only** — never which participant, and `confirmedByHuman` is only ever the count a named reviewer confirmed. |
| **Replay archive (§64)** | `competition/replay.ts` — one deterministic JSON bundle (session, participant, event, rounds, segments, metrics, timeline, evaluations, consensus, coach plans, artefact hashes, audit trail) with a **SHA-256 `contentHash`** over the key-sorted body so post-hoc tampering is detectable. Integrity detail is included in full only for a reviewer+; other callers get the redacted case views. |
| **Job queue (§107)** | `jobs/queue.ts` — in-process single-worker FIFO. Registered kinds: `integrity.analyzeSession`, `judge.evaluate`, `event.analytics`. Linear-backoff retry to `maxAttempts` (default 2), then `failed`; finished jobs pruned to a retention cap; `drain()` for tests. `POST /api/jobs`, `GET /api/jobs`, `/api/jobs/stats`, `/api/jobs/:id`. |
| **Audit surfacing (§72)** | `storage.listAuditByEvent()` + `GET /api/events/:id/audit` (admin). `user.registered` / `user.login` now audited alongside the existing event/session/judge/integrity/coach trail. |
| **Frontend** | `frontend/pages/admin.astro` + `AdminView.tsx` + `lib/adminApi.ts`, nav link added. Sign-in / create-account strip (or a "dev mode" banner when auth is off; token kept in `localStorage`, sent as a bearer so it works cross-origin in dev). Per-event admin leaderboard with a tie-break run; an analytics panel (histogram, judge-calibration table, integrity counts); a session-consensus lookup; a live job-queue panel; the event audit log. |
| **Tests** | 150 `node:test` cases (was 127). `auth.test.ts` — scrypt verify/reject/salt/malformed, token round-trip/wrong-secret/tampered-body/expired, role reach, `createUser` validation, storage user CRUD + unique email. `competition.test.ts` — single-eval consensus, divergence flag + outliers, **consensus carries no integrity field**, tie-break by criterion priority with explanation, unbreakable-tie shared rank, **public leaderboard exposes a label only** (greps for leaked risk terms), admin view keeps the risk, analytics judge leniency/harshness + integrity-counts-only. `queue.test.ts` — run/result, unregistered kind, retry-to-failed, fail-then-succeed, stats/list, retention prune. |

### Verified end-to-end

**Dev mode** (`AUTH_SECRET` unset): created an event + rubric + two participants + a
session; `/consensus`, `/leaderboard?view=public`, `/leaderboard?view=admin`,
`/analytics`, `/events/:id/audit` all return correct shapes; a queued `event.analytics`
job ran to `done` in one attempt; `/api/auth/me` reports `{ authEnabled:false, role:"admin",
dev:true }`.

**Auth enforced** (`AUTH_SECRET` set): protected route with no token → **401**; first
`register` → **bootstrap admin**; admin token → **200**; second `register` → **participant**;
participant registering a judge → **403**; admin registering a judge → **201**; participant
hitting `/api/jobs` → **403**; login with a bad password → **401**; `leaderboard?view=public`
open without a token → **200**; `leaderboard?view=admin` without a token → **403**.

Backend `tsc --noEmit` clean; `npm --workspace backend test` 150/150 green; frontend
`tsc` + `astro build` clean (8 pages, `/admin` built).

### Deferred / honest limits

- **Judge rooms** as a live collaborative surface (WebSocket rooms, presence) — the data
  model and consensus math are done; the realtime UI is not built.
- The job queue is **in-memory** — jobs do not survive a restart (spec §107 accepts a
  single-box queue; a durable queue needs Redis/Postgres).
- Tokens are **not server-revocable** individually — revocation is "delete the user" (the
  middleware re-checks existence every request). A deny-list needs storage.
- `SEARCH_PROVIDER` real implementations (Exa / Brave / Bing) still unbuilt — the mock
  corpus remains the source-search backend.

### New env

`AUTH_SECRET` — unset ⇒ dev mode (every request is admin); set ⇒ signed tokens + RBAC
enforced.
