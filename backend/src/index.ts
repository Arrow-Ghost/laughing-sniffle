// HTTP + WebSocket entrypoint. Thin: REST routing and WS transport only. All
// speech work lives in speech-core, all AI in the gateway, all durability in
// storage, all session lifecycle in the SessionManager.

import http from 'node:http';
import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { config, serverTranscription } from './config.ts';
import { HttpError } from './errors.ts';
import { AIGateway } from './ai/AIGateway.ts';
import { SqliteStorage } from './storage/SqliteStorage.ts';
import { SessionManager } from './session.ts';
import { JudgeEngine } from './judge-engine/index.ts';
import { IntegrityEngine } from './integrity/index.ts';
import { CoachEngine } from './coach/index.ts';
import { MockSourceSearchProvider } from './integrity/source-search/MockSourceSearchProvider.ts';
import { audit } from './audit.ts';
import { createEvent, createRound, createParticipant, ValidationError } from './domain/entities.ts';
import { createRubric, rubricFromPreset, RUBRIC_PRESETS } from './domain/rubrics.ts';
import { parseClientMessage, encode, type ServerMessage } from './shared/protocol.ts';
import type { Rubric, JobKind } from './domain/types.ts';
import { createUser as buildUser, publicUser, ROLES, type Role } from './auth/users.ts';
import { verifyPassword } from './auth/hash.ts';
import { signToken, TOKEN_TTL_MS } from './auth/tokens.ts';
import { requireRole, authEnabled, contextFor } from './auth/middleware.ts';
import { computeConsensus } from './competition/consensus.ts';
import { tiebreak, type TieBreakStanding } from './competition/tiebreak.ts';
import { buildLeaderboard } from './competition/leaderboard.ts';
import { eventAnalytics } from './competition/analytics.ts';
import { buildReplayBundle } from './competition/replay.ts';
import { JobQueue } from './jobs/queue.ts';

const storage = new SqliteStorage(config.databaseUrl);
const ai = new AIGateway({ apiKey: config.gemini.apiKey, models: config.gemini.models });
const sessions = new SessionManager(storage, ai);
const judge = new JudgeEngine(storage, ai);

// Phase 3 ships the mock provider; a real one (Exa / Brave / Bing) drops in here
// behind the same interface once SEARCH_PROVIDER names it and a key is set.
if (config.searchProvider !== 'mock') {
  console.log(`[shadowadj] SEARCH_PROVIDER=${config.searchProvider} not implemented yet — using the mock corpus`);
}
const integrity = new IntegrityEngine(storage, new MockSourceSearchProvider(), ai);
const coach = new CoachEngine(storage, ai);

/* --- Phase 7: job queue (spec §107). Long ops run here, off the request thread. --- */
const queue = new JobQueue();
queue.register('integrity.analyzeSession', (p) => integrity.analyzeSession(String(p.sessionId)));
queue.register('judge.evaluate', async (p) => {
  const sessionId = String(p.sessionId);
  const rubric = resolveRubric(sessionId, p.rubricId ? String(p.rubricId) : undefined);
  return judge.evaluate({ sessionId, rubric, judgeId: p.judgeId ? String(p.judgeId) : null });
});
queue.register('event.analytics', (p) => Promise.resolve(eventAnalytics(storage, String(p.eventId))));
const JOB_KINDS: JobKind[] = ['integrity.analyzeSession', 'judge.evaluate', 'event.analytics'];

if (authEnabled()) {
  console.log(`[shadowadj] auth: ENABLED — signed tokens + RBAC (admin > reviewer > judge > participant)`);
} else {
  console.log(`[shadowadj] auth: dev mode — every request runs as admin (set AUTH_SECRET to enforce RBAC)`);
}

/** Resolve the rubric to judge a session against: explicit id wins, else the
 *  session's event rubric, else 400. */
function resolveRubric(sessionId: string, explicitRubricId?: string): Rubric {
  if (explicitRubricId) {
    const r = storage.getRubric(explicitRubricId);
    if (!r) throw new HttpError(404, 'rubric not found');
    return r;
  }
  const session = storage.getSession(sessionId);
  if (!session) throw new HttpError(404, 'session not found');
  if (!session.eventId) throw new HttpError(400, 'no rubric: pass rubricId, or attach the session to an event with a rubric');
  const ev = storage.getEvent(session.eventId);
  if (!ev?.rubricId) throw new HttpError(400, 'the session’s event has no rubric — set one via PUT /api/events/:id/rubric');
  const r = storage.getRubric(ev.rubricId);
  if (!r) throw new HttpError(404, 'event rubric not found');
  return r;
}

const app = express();
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '256kb' }));

const wrap =
  (fn: (req: Request, res: Response) => unknown) =>
  (req: Request, res: Response, next: NextFunction) => {
    try {
      const out = fn(req, res);
      if (out instanceof Promise) out.catch(next);
    } catch (err) {
      next(err);
    }
  };

const rid = (req: Request): string => {
  const id = req.params.id;
  if (!id) throw new HttpError(400, 'missing :id');
  return id;
};

/* ------------------------------- health ------------------------------- */
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    geminiEnabled: ai.enabled(),
    model: config.gemini.models.transcribe[0],
    defaultTranscription: serverTranscription ? 'server' : 'browser',
    transcriptionModes: ai.enabled() ? ['server', 'browser'] : ['browser'],
  });
});

app.get('/api/ai/cost', (_req, res) => res.json(ai.costSummary()));

/* -------------------------------- auth (Phase 7) -------------------------------- */
//
// When AUTH_SECRET is unset the whole app runs as a dev admin, so these routes
// are for real deployments. The FIRST account created is an admin (bootstrap);
// after that, only an admin can mint a non-participant role.

function issue(res: Response, userId: string, role: Role, participantId: string | null): string {
  const exp = Date.now() + TOKEN_TTL_MS;
  const token = signToken({ userId, role, participantId, exp }, config.authSecret || 'dev-unsigned');
  res.setHeader(
    'Set-Cookie',
    `shadowadj_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(TOKEN_TTL_MS / 1000)}`,
  );
  return token;
}

app.post(
  '/api/auth/register',
  wrap((req, res) => {
    const b = req.body ?? {};
    const bootstrap = storage.countUsers() === 0;
    let role: Role = 'participant';
    if (bootstrap) {
      role = 'admin';
    } else if (b.role && b.role !== 'participant') {
      // Only an existing admin may create judges/reviewers/admins.
      const ctx = contextFor(req, storage);
      if (!ctx || ctx.role !== 'admin') throw new HttpError(403, 'only an admin can assign a non-participant role');
      if (!ROLES.includes(b.role)) throw new HttpError(400, `role must be one of ${ROLES.join(', ')}`);
      role = b.role;
    }
    if (b.email && storage.getUserByEmail(String(b.email))) throw new HttpError(409, 'that email is already registered');
    const user = buildUser({ name: b.name, password: b.password, role, email: b.email, participantId: b.participantId ?? null });
    storage.createUser(user);
    audit(storage, { action: 'user.registered', objectType: 'user', objectId: user.id, actor: user.id, next: { role } });
    const token = issue(res, user.id, user.role, user.participantId);
    res.status(201).json({ token, user: publicUser(user), bootstrap });
  }),
);

app.post(
  '/api/auth/login',
  wrap((req, res) => {
    const { email, password } = req.body ?? {};
    if (typeof email !== 'string' || typeof password !== 'string') throw new HttpError(400, 'email and password are required');
    const user = storage.getUserByEmail(email);
    if (!user || !verifyPassword(password, user.passwordHash)) throw new HttpError(401, 'invalid email or password');
    const token = issue(res, user.id, user.role, user.participantId);
    audit(storage, { action: 'user.login', objectType: 'user', objectId: user.id, actor: user.id });
    res.json({ token, user: publicUser(user) });
  }),
);

app.post('/api/auth/logout', (_req, res) => {
  res.setHeader('Set-Cookie', 'shadowadj_token=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get(
  '/api/auth/me',
  wrap((req, res) => {
    const ctx = contextFor(req, storage);
    if (!ctx) return res.status(401).json({ error: 'not authenticated' });
    const user = ctx.dev ? null : storage.getUser(ctx.userId);
    res.json({ authEnabled: authEnabled(), role: ctx.role, dev: ctx.dev, user: user ? publicUser(user) : null });
  }),
);

app.get('/api/auth/users', requireRole(storage, 'admin'), wrap((_req, res) => res.json(storage.listUsers().map(publicUser))));

/* ------------------------------- events ------------------------------- */
app.post(
  '/api/events',
  wrap((req, res) => {
    const ev = createEvent(req.body ?? {});
    storage.createEvent(ev);
    audit(storage, { action: 'event.created', objectType: 'event', objectId: ev.id, eventId: ev.id, next: ev });
    res.status(201).json(ev);
  }),
);
app.get('/api/events', wrap((_req, res) => res.json(storage.listEvents())));
app.get(
  '/api/events/:id',
  wrap((req, res) => {
    const ev = storage.getEvent(rid(req));
    if (!ev) throw new HttpError(404, 'event not found');
    res.json({
      ...ev,
      rounds: storage.listRoundsByEvent(ev.id),
      participants: storage.listParticipantsByEvent(ev.id),
    });
  }),
);
app.post(
  '/api/events/:id/rounds',
  wrap((req, res) => {
    if (!storage.getEvent(rid(req))) throw new HttpError(404, 'event not found');
    const existing = storage.listRoundsByEvent(rid(req));
    const index = req.body?.index ?? existing.length + 1;
    const r = createRound({ eventId: rid(req), index, name: req.body?.name });
    storage.createRound(r);
    res.status(201).json(r);
  }),
);
app.post(
  '/api/events/:id/participants',
  wrap((req, res) => {
    if (!storage.getEvent(rid(req))) throw new HttpError(404, 'event not found');
    const p = createParticipant({ eventId: rid(req), displayName: req.body?.displayName, seat: req.body?.seat });
    storage.createParticipant(p);
    res.status(201).json(p);
  }),
);
app.put(
  '/api/events/:id/rubric',
  wrap((req, res) => {
    const ev = storage.getEvent(rid(req));
    if (!ev) throw new HttpError(404, 'event not found');
    let rubric: Rubric;
    if (req.body?.rubricId) {
      const r = storage.getRubric(req.body.rubricId);
      if (!r) throw new HttpError(404, 'rubric not found');
      rubric = r;
    } else if (req.body?.preset) {
      rubric = storage.createRubric(rubricFromPreset(req.body.preset, ev.id));
    } else {
      throw new HttpError(400, 'pass { rubricId } or { preset }');
    }
    storage.setEventRubric(ev.id, rubric.id);
    audit(storage, { action: 'event.rubric.set', objectType: 'event', objectId: ev.id, eventId: ev.id, next: { rubricId: rubric.id } });
    res.json(rubric);
  }),
);

/* ------------------------------- rubrics ----------------------------- */
app.get('/api/rubrics/presets', (_req, res) =>
  res.json(Object.entries(RUBRIC_PRESETS).map(([key, p]) => ({ key, name: p.name, eventType: p.eventType, criteria: p.criteria.map((c) => ({ name: c.name, weight: c.weight })) }))),
);
app.get('/api/rubrics', wrap((req, res) => res.json(storage.listRubrics(req.query.eventId ? { eventId: String(req.query.eventId) } : {}))));
app.post(
  '/api/rubrics',
  wrap((req, res) => {
    const b = req.body ?? {};
    const rubric = b.preset
      ? rubricFromPreset(b.preset, b.eventId ?? null)
      : createRubric({ name: b.name, eventType: b.eventType, criteria: b.criteria, eventId: b.eventId ?? null });
    storage.createRubric(rubric);
    res.status(201).json(rubric);
  }),
);
app.get(
  '/api/rubrics/:id',
  wrap((req, res) => {
    const r = storage.getRubric(rid(req));
    if (!r) throw new HttpError(404, 'rubric not found');
    res.json(r);
  }),
);

/* ------------------------------ sessions ----------------------------- */
app.post(
  '/api/sessions',
  wrap((req, res) => {
    const { mode, label, consent, eventId, roundId, participantId, transcriptSource, languages, expectSpeakers } = req.body ?? {};
    const rt = sessions.create({ mode, label, consent, eventId, roundId, participantId, transcriptSource, languages, expectSpeakers });
    res.status(201).json({
      id: rt.entity.id,
      mode: rt.entity.mode,
      label: rt.entity.label,
      consent: rt.entity.consent,
      eventId: rt.entity.eventId,
      languages: rt.entity.languages,
      expectSpeakers: rt.entity.expectSpeakers,
      wsUrl: `/ws?sessionId=${rt.entity.id}`,
    });
  }),
);

app.get('/api/sessions/:id/export', wrap((req, res) => res.json(sessions.export(rid(req)))));
app.get('/api/sessions/:id/audit', wrap((req, res) => res.json(sessions.auditTrail(rid(req)))));
app.get('/api/sessions/:id/timeline', wrap((req, res) => res.json(storage.listTimeline(rid(req)))));
app.get('/api/sessions/:id/language', wrap((req, res) => res.json(sessions.languageProfile(rid(req)))));
app.get('/api/sessions/:id/speakers', wrap((req, res) => res.json(sessions.diarization(rid(req)))));
app.get(
  '/api/sessions/:id/transcript',
  wrap(async (req, res) => {
    const target = typeof req.query.translate === 'string' ? req.query.translate : null;
    if (target) res.json(await sessions.translatedTranscript(rid(req), target));
    else res.json(storage.listSegments(rid(req)).filter((s) => s.isFinal));
  }),
);
app.post('/api/sessions/:id/end', wrap(async (req, res) => res.json(await sessions.end(rid(req)))));

/* ---------------------------- judging (Phase 2) --------------------------- */
app.post(
  '/api/sessions/:id/evaluations',
  wrap(async (req, res) => {
    if (!ai.enabled()) throw new HttpError(400, 'Judging needs GEMINI_API_KEY');
    const sessionId = rid(req);
    const rubric = resolveRubric(sessionId, req.body?.rubricId);
    const evaluation = await judge.evaluate({ sessionId, rubric, judgeId: req.body?.judgeId ?? null });
    res.status(201).json(evaluation);
  }),
);
app.get('/api/sessions/:id/evaluations', wrap((req, res) => res.json(storage.listEvaluations(rid(req)))));

app.get(
  '/api/evaluations/:id',
  wrap((req, res) => {
    const ev = storage.getEvaluation(rid(req));
    if (!ev) throw new HttpError(404, 'evaluation not found');
    res.json(ev);
  }),
);
app.patch(
  '/api/evaluations/:id/criteria/:criterionId',
  requireRole(storage, 'judge'),
  wrap((req, res) => {
    const criterionId = req.params.criterionId;
    if (!criterionId) throw new HttpError(400, 'missing :criterionId');
    res.json(
      judge.applyOverride({
        evaluationId: rid(req),
        criterionId,
        humanScore: req.body?.humanScore,
        reason: req.body?.reason,
        reviewer: req.body?.reviewer,
      }),
    );
  }),
);
app.post(
  '/api/evaluations/:id/finalize',
  requireRole(storage, 'judge'),
  wrap((req, res) =>
    res.json(judge.finalize({ evaluationId: rid(req), reviewer: req.body?.reviewer, notes: req.body?.notes })),
  ),
);
app.post(
  '/api/evaluations/:id/reopen',
  requireRole(storage, 'judge'),
  wrap((req, res) => {
    const ev = storage.getEvaluation(rid(req));
    if (!ev) throw new HttpError(404, 'evaluation not found');
    ev.status = 'draft';
    storage.updateEvaluation(ev);
    audit(storage, { action: 'evaluation.reopened', objectType: 'evaluation', objectId: ev.id, sessionId: ev.sessionId, actor: req.body?.reviewer ?? 'human' });
    res.json(ev);
  }),
);

/* --------------------------- integrity (Phase 3) ------------------------- */
app.post(
  '/api/sessions/:id/integrity',
  wrap(async (req, res) => res.status(201).json(await integrity.analyzeSession(rid(req)))),
);
app.get(
  '/api/sessions/:id/integrity',
  wrap((req, res) =>
    res.json({
      cases: storage.listIntegrityCasesBySession(rid(req)),
      analytics: storage.listIntegrityAnalyticsBySession(rid(req)),
    }),
  ),
);
app.get(
  '/api/events/:id/integrity',
  wrap((req, res) => {
    if (!storage.getEvent(rid(req))) throw new HttpError(404, 'event not found');
    res.json(storage.listIntegrityCasesByEvent(rid(req)));
  }),
);
app.get(
  '/api/integrity-cases/:id',
  wrap((req, res) => {
    const c = storage.getIntegrityCase(rid(req));
    if (!c) throw new HttpError(404, 'integrity case not found');
    res.json(c);
  }),
);
app.post(
  '/api/integrity-cases/:id/review',
  requireRole(storage, 'reviewer'),
  wrap((req, res) =>
    res.json(
      integrity.review({
        caseId: rid(req),
        reviewerId: req.body?.reviewerId,
        decision: req.body?.decision,
        reason: req.body?.reason,
        notes: req.body?.notes,
      }),
    ),
  ),
);
app.get('/api/integrity-cases/:id/graph', wrap((req, res) => res.json(integrity.sourceGraph(rid(req)))));
// Participant-facing view — evidence without internal weighting or other names (spec §43, §79).
app.get('/api/integrity-cases/:id/participant-view', wrap((req, res) => res.json(integrity.redactedCase(rid(req)))));
app.post(
  '/api/integrity-cases/:id/appeal',
  wrap((req, res) =>
    res.status(201).json(
      integrity.appeal({
        caseId: rid(req),
        submittedBy: req.body?.submittedBy,
        statement: req.body?.statement,
        sourceAttribution: req.body?.sourceAttribution,
      }),
    ),
  ),
);
app.post(
  '/api/integrity-appeals/:id/respond',
  requireRole(storage, 'reviewer'),
  wrap((req, res) =>
    res.json(
      integrity.respondAppeal({
        appealId: rid(req),
        reviewerId: req.body?.reviewerId,
        decision: req.body?.decision,
        reason: req.body?.reason,
      }),
    ),
  ),
);
app.get('/api/sessions/:id/artifacts', wrap((req, res) => {
  const a = storage.getSessionArtifacts(rid(req));
  if (!a) throw new HttpError(404, 'no artefact hashes for this session yet (it may still be live)');
  res.json(a);
}));

app.post(
  '/api/sessions/:id/coaching',
  wrap(async (req, res) => {
    if (!ai.enabled()) throw new HttpError(400, 'Coaching notes need GEMINI_API_KEY');
    const rt = sessions.getRuntime(rid(req));
    const snap = rt.core.snapshot();
    if (snap.transcript.wordCount < 30) throw new HttpError(422, 'Not enough transcript yet for useful notes');
    const result = await ai.generateCoach({
      transcript: snap.transcript.text,
      metrics: {
        pace: snap.pace,
        pauses: snap.pauses,
        fillers: snap.fillers,
        vocabulary: snap.vocabulary,
        delivery: snap.delivery,
      },
    });
    rt.lastCoaching = { ...result, at: Date.now() };
    audit(storage, { action: 'coaching.generated', objectType: 'session', objectId: rt.entity.id, sessionId: rt.entity.id });
    // `notes` is the client-facing field; keep the shape it already expects plus summary.
    res.json({ notes: result.notes.join('\n\n'), items: result.notes, summary: result.summary, at: rt.lastCoaching.at });
  }),
);

/* ---------------------------- coaching (Phase 6) ------------------------- */
app.post(
  '/api/sessions/:id/coach/plan',
  wrap(async (req, res) => {
    if (!ai.enabled()) throw new HttpError(400, 'Coaching needs GEMINI_API_KEY');
    res.status(201).json(await coach.plan({ sessionId: rid(req), evaluationId: req.body?.evaluationId, persona: req.body?.persona }));
  }),
);
app.get('/api/sessions/:id/coach/plans', wrap((req, res) => res.json(storage.listCoachPlansBySession(rid(req)))));
app.get(
  '/api/coach-plans/:id',
  wrap((req, res) => {
    const p = storage.getCoachPlan(rid(req));
    if (!p) throw new HttpError(404, 'coach plan not found');
    res.json({ ...p, drills: storage.listDrillsByPlan(p.id) });
  }),
);
app.post(
  '/api/coach-plans/:id/drills',
  wrap(async (req, res) =>
    res.status(201).json(
      await coach.startDrill({ planId: rid(req), type: req.body?.type, difficulty: req.body?.difficulty, weaknessIndex: req.body?.weaknessIndex }),
    ),
  ),
);
app.get(
  '/api/drills/:id',
  wrap((req, res) => {
    const d = storage.getDrill(rid(req));
    if (!d) throw new HttpError(404, 'drill not found');
    res.json(d);
  }),
);
app.post('/api/drills/:id/response', wrap((req, res) => res.json(coach.attachResponse({ drillId: rid(req), responseSessionId: req.body?.responseSessionId }))));
app.post('/api/drills/:id/grade', wrap(async (req, res) => res.json(await coach.gradeDrill({ drillId: rid(req) }))));
app.post(
  '/api/drills/:id/opponent',
  wrap(async (req, res) =>
    res.json(await coach.opponentTurn({ drillId: rid(req), lastArgument: req.body?.lastArgument, config: req.body?.config, topic: req.body?.topic })),
  ),
);
app.post(
  '/api/coach/compare',
  wrap((req, res) => {
    const { beforeSessionId, afterSessionId } = req.body ?? {};
    if (!beforeSessionId || !afterSessionId) throw new HttpError(400, 'beforeSessionId and afterSessionId are required');
    res.json(coach.compare({ beforeSessionId, afterSessionId }));
  }),
);
app.get('/api/participants/:id/progress', wrap((req, res) => res.json(coach.progress(rid(req)))));

/* ----------------------- competition OS (Phase 7) ----------------------- */

// Multi-judge consensus for one session (spec §49). Performance only — no integrity.
app.get('/api/sessions/:id/consensus', requireRole(storage, 'judge'), wrap((req, res) => res.json(computeConsensus(storage, rid(req)))));

// Tie-break a set of standings deterministically (spec §51). Body: { standings[], rules?, roundId? }.
app.post(
  '/api/events/:id/tiebreak',
  requireRole(storage, 'judge'),
  wrap((req, res) => {
    const eventId = rid(req);
    if (!storage.getEvent(eventId)) throw new HttpError(404, 'event not found');
    const standings = req.body?.standings as TieBreakStanding[] | undefined;
    if (!Array.isArray(standings) || standings.length === 0) {
      // Derive standings from the event's leaderboard + consensus when none are passed.
      const lb = buildLeaderboard(storage, eventId, 'admin');
      const derived: TieBreakStanding[] = lb.rows
        .filter((r) => r.overallScore != null)
        .map((r) => ({
          participantId: r.participantId,
          participantLabel: r.participantLabel,
          overallScore: r.overallScore!,
          criterionMeans: Object.fromEntries((r.admin?.perCriterion ?? []).map((c) => [c.criterionName, c.mean])),
          consensusSpread: r.admin?.consensusSpread ?? 0,
          humanJudgeCount: r.admin?.judgeCount ?? 0,
        }));
      return res.json(tiebreak(derived, req.body?.rules ?? {}, { eventId, roundId: req.body?.roundId ?? null }));
    }
    res.json(tiebreak(standings, req.body?.rules ?? {}, { eventId, roundId: req.body?.roundId ?? null }));
  }),
);

// Leaderboard. Public view is open; admin view (risk + spread + judge counts) needs a judge role.
app.get(
  '/api/events/:id/leaderboard',
  wrap((req, res) => {
    const eventId = rid(req);
    if (!storage.getEvent(eventId)) throw new HttpError(404, 'event not found');
    const wantsAdmin = String(req.query.view ?? 'public') === 'admin';
    if (wantsAdmin) {
      const ctx = contextFor(req, storage);
      if (!ctx || (ctx.role !== 'admin' && ctx.role !== 'judge' && ctx.role !== 'reviewer')) {
        throw new HttpError(403, 'the admin leaderboard view needs a judge, reviewer or admin role');
      }
    }
    res.json(buildLeaderboard(storage, eventId, wantsAdmin ? 'admin' : 'public'));
  }),
);

// Post-event analytics (spec §63).
app.get(
  '/api/events/:id/analytics',
  requireRole(storage, 'reviewer'),
  wrap((req, res) => {
    if (!storage.getEvent(rid(req))) throw new HttpError(404, 'event not found');
    res.json(eventAnalytics(storage, rid(req)));
  }),
);

// Event-wide audit log (spec §72).
app.get(
  '/api/events/:id/audit',
  requireRole(storage, 'admin'),
  wrap((req, res) => {
    if (!storage.getEvent(rid(req))) throw new HttpError(404, 'event not found');
    res.json(storage.listAuditByEvent(rid(req)));
  }),
);

// Replay archive bundle (spec §64). Integrity detail only for a reviewer+.
app.get(
  '/api/sessions/:id/replay',
  requireRole(storage, 'judge'),
  wrap((req, res) => {
    const ctx = contextFor(req, storage);
    const includeIntegrityDetail = !!ctx && (ctx.role === 'admin' || ctx.role === 'reviewer');
    res.json(buildReplayBundle(storage, integrity, rid(req), { includeIntegrityDetail }));
  }),
);

/* ------------------------------ job queue ------------------------------ */
app.post(
  '/api/jobs',
  requireRole(storage, 'judge'),
  wrap((req, res) => {
    const kind = req.body?.kind as JobKind | undefined;
    if (!kind || !JOB_KINDS.includes(kind)) throw new HttpError(400, `kind must be one of ${JOB_KINDS.join(', ')}`);
    const job = queue.enqueue(kind, (req.body?.payload ?? {}) as Record<string, unknown>, {
      maxAttempts: req.body?.maxAttempts,
    });
    res.status(202).json(job);
  }),
);
app.get('/api/jobs', requireRole(storage, 'judge'), wrap((req, res) => res.json(queue.list({ limit: Number(req.query.limit) || 50 }))));
app.get('/api/jobs/stats', requireRole(storage, 'judge'), wrap((_req, res) => res.json(queue.stats())));
app.get(
  '/api/jobs/:id',
  requireRole(storage, 'judge'),
  wrap((req, res) => {
    const job = queue.get(rid(req));
    if (!job) throw new HttpError(404, 'job not found');
    res.json(job);
  }),
);

/* --------------------------- error handler -------------------------- */
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const status = err instanceof HttpError ? err.status : err instanceof ValidationError ? 400 : 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err instanceof Error ? err.message : 'internal error' });
});

/* ---------------------------- websocket ---------------------------- */
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url ?? '', 'http://localhost');
  const sessionId = url.searchParams.get('sessionId') ?? '';
  let rt;
  try {
    rt = sessions.getRuntime(sessionId);
  } catch {
    ws.close(4004, 'unknown session');
    return;
  }

  rt.clients.add(ws);
  rt._connectCount += 1;
  const send = (msg: ServerMessage) => ws.readyState === WebSocket.OPEN && ws.send(encode(msg));
  send({ type: 'ready', geminiEnabled: ai.enabled(), defaultTranscription: serverTranscription ? 'server' : 'browser' });

  const tick = setInterval(() => {
    send({
      type: 'tick',
      snapshot: rt.core.snapshot(),
      energy: rt.core.energyTimeline(),
      transcribing: rt.core.transcribing,
      timer: rt.timerState(),
    });
  }, 500);

  ws.on('message', (data, isBinary) => {
    if (isBinary) {
      rt.core.ingestAudio(Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer));
      return;
    }
    const msg = parseClientMessage(data.toString());
    if (!msg) return;
    switch (msg.type) {
      case 'hello':
        send({ type: 'config', transcriptSource: rt.core.transcriptSource });
        break;
      case 'transcript':
        rt.core.ingestBrowserTranscript(msg.text, msg.isFinal ?? false);
        break;
      case 'question':
        rt.core.markQuestion(msg.label ?? 'Question');
        break;
      case 'end':
        sessions
          .end(sessionId)
          .then((exported) => send({ type: 'ended', export: exported }))
          .catch(() => send({ type: 'error', message: 'failed to finalise session' }));
        break;
    }
  });

  ws.on('close', () => {
    clearInterval(tick);
    rt.clients.delete(ws);
  });
});

server.listen(config.port, () => {
  console.log(`[shadowadj] backend on http://localhost:${config.port}`);
  console.log(`[shadowadj] CORS origin: ${config.corsOrigin}`);
});

process.on('SIGINT', () => {
  storage.close();
  process.exit(0);
});
