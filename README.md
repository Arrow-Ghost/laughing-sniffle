# ShadowADJ

A **consent-first, real-time speech practice & reflection console** for debate practice,
interview preparation, and speech coaching.

ShadowADJ listens to live speech and shows *descriptive* metrics about how someone is
speaking — pace, pauses, filler-word rate, vocabulary diversity, answer latency — plus
an optional set of self-directed coaching notes. It is a mirror, not a judge.

## What ShadowADJ deliberately does not do

- It does **not** produce an "AI-likelihood", "cheating probability", or any
  accept/review/reject verdict about a person.
- It does **not** run covert monitoring. The person being recorded always sees the
  same dashboard as everyone else, and a session cannot start until consent is
  acknowledged in the UI.
- It does **not** build a per-person "baseline" and then score deviations from it as
  suspicion. Baselines exist only as an optional personal progress comparison, shown
  to the speaker.

These constraints are enforced in the code (`speech-core`, the snapshot test), not just
the UI copy.

> **Building toward a competition platform.** ShadowADJ is being extended into an
> AI-assisted judging, integrity-review, and coaching system. See
> [`IMPLEMENTATION_PLAN.md`](./IMPLEMENTATION_PLAN.md) for the audit, the target
> architecture, and phase status. **Phase 1** (foundation), **Phase 2** (rubrics +
> Judge Engine + evidence timeline + human override, `/judge` view), **Phase 3**
> (Integrity Engine: source matching, cross-participant similarity, risk levels +
> human review, `/review` view), **Phase 4** (style baseline, preparedness,
> session-integrity hashing + tamper detection, appeals, source graph) and
> **Phase 5** (multilingual transcription, code-switch detection, translation
> alongside the original, best-effort diarization), **Phase 6** (coaching:
> weaknesses quoted verbatim from the judge, adaptive drills, AI opponent,
> before/after + progress) and **Phase 7** (Competition OS: real auth + RBAC,
> multi-judge consensus + variance, deterministic tie-break, public/admin
> leaderboard split, post-event analytics, replay archive bundle, event audit,
> in-process job queue, `/admin` view) are done. The reflection console below is
> unchanged.
>
> Quick judging run: `POST /api/events` → `PUT /api/events/:id/rubric {"preset":"debate"}`
> → create a session with that `eventId` → record → `POST /api/sessions/:id/evaluations`
> → open `/judge?session=<id>`. Integrity: `POST /api/sessions/:id/integrity` →
> `/review?session=<id>`. Competition ops: `/admin` — leaderboard, consensus,
> analytics, audit, jobs. Auth is off until you set `AUTH_SECRET` (then the first
> account registered becomes the admin).

## Architecture

```
cadence/
  backend/   TypeScript, run directly by Node 25 (no build step)
    src/
      speech-core/   audio ingest → streaming VAD → analyzer; transcription pump
      ai/            AIGateway — the one Gemini call site (routing, validation, cost)
      storage/       StorageProvider iface + SqliteStorage (node:sqlite, one file)
      domain/        Event / Round / Participant / Session / … entities + validators
      judge-engine/  rubric-driven criterion scoring + evidence + confidence guard
      integrity/     source matching, cross-participant, style, session hashing
      coach/         weaknesses (verbatim from judge) → adaptive drills + opponent
      competition/   multi-judge consensus, tie-break, leaderboard, analytics, replay
      auth/          scrypt hashing, HMAC signed tokens, RBAC middleware
      jobs/          in-process job queue
      shared/        typed WebSocket protocol
      session.ts     SessionManager — runtime sessions ↔ durable storage
      index.ts       thin REST + WS transport
  frontend/  Astro + React islands + Three.js + Tailwind + Zustand
```

### Data flow

```
Browser  --16 kHz PCM16 frames over WebSocket-->  SpeechCore
SpeechCore  --6–12 s chunks-->  AIGateway (Gemini)  --transcript-->  analyzer + SQLite
SpeechCore  --descriptive snapshot every 500 ms over WebSocket-->  console
```

## Setup

```bash
# from cadence/
cp .env.example .env      # then fill in GEMINI_API_KEY if you want transcription
npm install               # installs backend + frontend (npm workspaces)
npm run dev                # starts backend :8787 and frontend :4321
```

Open http://localhost:4321. The SQLite file is created at `backend/data/shadowadj.db`
(gitignored). Run `npm --workspace backend test` for the 150-case suite,
`npm --workspace backend run typecheck` for `tsc`.

### Environment

| Variable                  | Required | Purpose                                                                                              |
| ------------------------- | -------- | -------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`          | no       | Enables server-side transcription + coaching notes. Without it, ShadowADJ uses the browser Web Speech API (Chrome only). |
| `GEMINI_TRANSCRIBE_MODEL` | no       | Fast model for live transcription (default `gemini-3.5-flash-lite`; falls back to other lite models on 404/503). |
| `GEMINI_MODEL`            | no       | Stronger model for coaching notes (default `gemini-3.6-flash`).                                     |
| `GEMINI_JUDGE_MODEL` / `GEMINI_SIMILARITY_MODEL` / `GEMINI_SUMMARIZE_MODEL` | no | Model-routing overrides for the engines built in later phases.                     |
| `TRANSCRIPTION`           | no       | `auto` (server when a key is set, else browser) or `browser` to force Web Speech.                   |
| `DATABASE_URL`            | no       | SQLite file (default `file:./data/shadowadj.db`). `:memory:` for an ephemeral store.               |
| `SEARCH_PROVIDER`         | no       | External source-search provider for the Integrity Engine (default `mock`, unused until Phase 3).   |
| `AUTH_SECRET`             | no       | Unset ⇒ dev mode (every request runs as admin). Set ⇒ HMAC-signed tokens + RBAC enforced; the first registered account bootstraps as admin. |
| `PORT`                    | no       | Backend port (default `8787`).                                                                     |
| `CORS_ORIGIN`             | no       | Allowed frontend origin (default `http://localhost:4321`).                                         |

**Never commit `.env`.** If a key is ever pasted into a chat, an issue, or a commit,
treat it as compromised and rotate it.

## License

MIT
