// SqliteStorage — StorageProvider backed by Node's built-in node:sqlite.
// No native module to compile; the DB is a single file. Experimental-flagged in
// Node, functional and sufficient for a single-box competition build.

import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorageProvider } from './StorageProvider.ts';
import type { User } from '../auth/users.ts';
import type {
  AuditEvent,
  CoachPlan,
  Drill,
  Event,
  EventStatus,
  Id,
  IntegrityAnalytics,
  IntegrityAppeal,
  IntegrityCase,
  JudgeEvaluation,
  Participant,
  Round,
  Rubric,
  Session,
  SessionArtifacts,
  SpeechMetric,
  StyleBaseline,
  TimelineEvent,
  TranscriptSegment,
} from '../domain/types.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA = fs.readFileSync(path.join(here, 'schema.sql'), 'utf8');

type Row = Record<string, unknown>;
const j = (v: unknown): string => JSON.stringify(v ?? null);
const p = <T>(v: unknown): T => JSON.parse(String(v)) as T;

export class SqliteStorage implements StorageProvider {
  private db: DatabaseSync;

  constructor(fileUrl: string) {
    const file = fileUrl.replace(/^file:/, '') || './data/shadowadj.db';
    if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Idempotent column adds for DBs created before Phase 4. */
  private migrate(): void {
    const adds = [
      `ALTER TABLE integrity_cases ADD COLUMN participant_id TEXT`,
      `ALTER TABLE integrity_cases ADD COLUMN style_analysis TEXT`,
      `ALTER TABLE integrity_cases ADD COLUMN preparedness TEXT`,
      `ALTER TABLE integrity_cases ADD COLUMN session_integrity TEXT`,
      `ALTER TABLE sessions ADD COLUMN languages TEXT NOT NULL DEFAULT '[]'`,
      `ALTER TABLE sessions ADD COLUMN expect_speakers INTEGER NOT NULL DEFAULT 1`,
    ];
    for (const sql of adds) {
      try {
        this.db.exec(sql);
      } catch {
        /* column already exists */
      }
    }
  }

  // --- events ---------------------------------------------------------
  createEvent(e: Event): Event {
    this.db
      .prepare(
        `INSERT INTO events (id, created_at, name, type, description, status, policy, rubric_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(e.id, e.createdAt, e.name, e.type, e.description, e.status, j(e.policy), e.rubricId);
    return e;
  }
  getEvent(id: Id): Event | null {
    const r = this.db.prepare(`SELECT * FROM events WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToEvent(r) : null;
  }
  listEvents(): Event[] {
    return (this.db.prepare(`SELECT * FROM events ORDER BY created_at DESC`).all() as Row[]).map((r) =>
      this.rowToEvent(r),
    );
  }
  setEventStatus(id: Id, status: EventStatus): void {
    this.db.prepare(`UPDATE events SET status = ? WHERE id = ?`).run(status, id);
  }
  setEventRubric(id: Id, rubricId: Id): void {
    this.db.prepare(`UPDATE events SET rubric_id = ? WHERE id = ?`).run(rubricId, id);
  }
  private rowToEvent(r: Row): Event {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      name: String(r.name),
      type: r.type as Event['type'],
      description: String(r.description ?? ''),
      status: r.status as EventStatus,
      policy: p(r.policy),
      rubricId: (r.rubric_id as string | null) ?? null,
    };
  }

  // --- rounds -------------------------------------------------------
  createRound(r: Round): Round {
    this.db
      .prepare(`INSERT INTO rounds (id, created_at, event_id, idx, name, status) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.createdAt, r.eventId, r.index, r.name, r.status);
    return r;
  }
  getRound(id: Id): Round | null {
    const r = this.db.prepare(`SELECT * FROM rounds WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToRound(r) : null;
  }
  listRoundsByEvent(eventId: Id): Round[] {
    return (this.db.prepare(`SELECT * FROM rounds WHERE event_id = ? ORDER BY idx`).all(eventId) as Row[]).map(
      (r) => this.rowToRound(r),
    );
  }
  private rowToRound(r: Row): Round {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      eventId: String(r.event_id),
      index: Number(r.idx),
      name: String(r.name),
      status: r.status as Round['status'],
    };
  }

  // --- participants ---------------------------------------------
  createParticipant(pt: Participant): Participant {
    this.db
      .prepare(`INSERT INTO participants (id, created_at, event_id, display_name, seat) VALUES (?, ?, ?, ?, ?)`)
      .run(pt.id, pt.createdAt, pt.eventId, pt.displayName, pt.seat);
    return pt;
  }
  getParticipant(id: Id): Participant | null {
    const r = this.db.prepare(`SELECT * FROM participants WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToParticipant(r) : null;
  }
  listParticipantsByEvent(eventId: Id): Participant[] {
    return (
      this.db.prepare(`SELECT * FROM participants WHERE event_id = ? ORDER BY created_at`).all(eventId) as Row[]
    ).map((r) => this.rowToParticipant(r));
  }
  private rowToParticipant(r: Row): Participant {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      eventId: (r.event_id as string | null) ?? null,
      displayName: String(r.display_name),
      seat: (r.seat as string | null) ?? null,
    };
  }

  // --- sessions -----------------------------------------------
  createSession(s: Session): Session {
    this.db
      .prepare(
        `INSERT INTO sessions
           (id, created_at, event_id, round_id, participant_id, mode, label, consent, status, started_at, ended_at, languages, expect_speakers)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id, s.createdAt, s.eventId, s.roundId, s.participantId, s.mode, s.label,
        j(s.consent), s.status, s.startedAt, s.endedAt, j(s.languages), s.expectSpeakers,
      );
    return s;
  }
  getSession(id: Id): Session | null {
    const r = this.db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToSession(r) : null;
  }
  listSessions(opts: { eventId?: Id; limit?: number } = {}): Session[] {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const rows = opts.eventId
      ? (this.db
          .prepare(`SELECT * FROM sessions WHERE event_id = ? ORDER BY created_at DESC LIMIT ?`)
          .all(opts.eventId, limit) as Row[])
      : (this.db.prepare(`SELECT * FROM sessions ORDER BY created_at DESC LIMIT ?`).all(limit) as Row[]);
    return rows.map((r) => this.rowToSession(r));
  }
  endSession(id: Id, endedAt: number): void {
    this.db.prepare(`UPDATE sessions SET status = 'ended', ended_at = ? WHERE id = ?`).run(endedAt, id);
  }
  private rowToSession(r: Row): Session {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      eventId: (r.event_id as string | null) ?? null,
      roundId: (r.round_id as string | null) ?? null,
      participantId: (r.participant_id as string | null) ?? null,
      mode: r.mode as Session['mode'],
      label: String(r.label),
      consent: p(r.consent),
      status: r.status as Session['status'],
      startedAt: r.started_at == null ? null : Number(r.started_at),
      endedAt: r.ended_at == null ? null : Number(r.ended_at),
      languages: r.languages == null ? [] : p<string[]>(r.languages),
      expectSpeakers: r.expect_speakers == null ? 1 : Number(r.expect_speakers),
    };
  }

  // --- transcript ------------------------------------------
  appendSegment(seg: TranscriptSegment): void {
    this.db
      .prepare(
        `INSERT INTO transcript_segments
           (id, created_at, session_id, source, t0, t1, text, is_final, lang, speaker_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        seg.id, seg.createdAt, seg.sessionId, seg.source, seg.t0, seg.t1, seg.text,
        seg.isFinal ? 1 : 0, seg.lang, seg.speakerId,
      );
  }
  listSegments(sessionId: Id): TranscriptSegment[] {
    return (
      this.db
        .prepare(`SELECT * FROM transcript_segments WHERE session_id = ? ORDER BY t0, created_at`)
        .all(sessionId) as Row[]
    ).map((r) => ({
      id: String(r.id),
      createdAt: Number(r.created_at),
      sessionId: String(r.session_id),
      source: r.source as TranscriptSegment['source'],
      t0: Number(r.t0),
      t1: Number(r.t1),
      text: String(r.text),
      isFinal: Number(r.is_final) === 1,
      lang: (r.lang as string | null) ?? null,
      speakerId: (r.speaker_id as string | null) ?? null,
    }));
  }

  // --- speech metrics -----------------------------------
  appendMetric(m: SpeechMetric): void {
    this.db
      .prepare(`INSERT INTO speech_metrics (id, created_at, session_id, at_ms, kind, snapshot) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.createdAt, m.sessionId, m.atMs, m.kind, j(m.snapshot));
  }
  latestMetric(sessionId: Id): SpeechMetric | null {
    const r = this.db
      .prepare(`SELECT * FROM speech_metrics WHERE session_id = ? ORDER BY at_ms DESC LIMIT 1`)
      .get(sessionId) as Row | undefined;
    return r ? this.rowToMetric(r) : null;
  }
  listMetrics(sessionId: Id): SpeechMetric[] {
    return (
      this.db.prepare(`SELECT * FROM speech_metrics WHERE session_id = ? ORDER BY at_ms`).all(sessionId) as Row[]
    ).map((r) => this.rowToMetric(r));
  }
  private rowToMetric(r: Row): SpeechMetric {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      sessionId: String(r.session_id),
      atMs: Number(r.at_ms),
      kind: r.kind as SpeechMetric['kind'],
      snapshot: p(r.snapshot),
    };
  }

  // --- audit -------------------------------------------
  appendAudit(a: AuditEvent): void {
    this.db
      .prepare(
        `INSERT INTO audit_events
           (id, created_at, actor, action, object_type, object_id, session_id, event_id, prev, next)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.createdAt, a.actor, a.action, a.objectType, a.objectId, a.sessionId, a.eventId, j(a.prev), j(a.next));
  }
  listAuditBySession(sessionId: Id): AuditEvent[] {
    return (
      this.db
        .prepare(`SELECT * FROM audit_events WHERE session_id = ? ORDER BY created_at`)
        .all(sessionId) as Row[]
    ).map((r) => ({
      id: String(r.id),
      createdAt: Number(r.created_at),
      actor: String(r.actor),
      action: String(r.action),
      objectType: String(r.object_type),
      objectId: String(r.object_id),
      sessionId: (r.session_id as string | null) ?? null,
      eventId: (r.event_id as string | null) ?? null,
      prev: r.prev == null ? null : p(r.prev),
      next: r.next == null ? null : p(r.next),
    }));
  }

  // --- rubrics (Phase 2) -----------------------------------
  createRubric(r: Rubric): Rubric {
    this.db
      .prepare(`INSERT INTO rubrics (id, created_at, event_id, name, event_type, criteria) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.createdAt, r.eventId, r.name, r.eventType, j(r.criteria));
    return r;
  }
  getRubric(id: Id): Rubric | null {
    const r = this.db.prepare(`SELECT * FROM rubrics WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToRubric(r) : null;
  }
  listRubrics(opts: { eventId?: Id } = {}): Rubric[] {
    const rows = opts.eventId
      ? (this.db.prepare(`SELECT * FROM rubrics WHERE event_id = ? ORDER BY created_at DESC`).all(opts.eventId) as Row[])
      : (this.db.prepare(`SELECT * FROM rubrics ORDER BY created_at DESC`).all() as Row[]);
    return rows.map((r) => this.rowToRubric(r));
  }
  private rowToRubric(r: Row): Rubric {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      eventId: (r.event_id as string | null) ?? null,
      name: String(r.name),
      eventType: r.event_type as Rubric['eventType'],
      criteria: p(r.criteria),
    };
  }

  // --- timeline events (Phase 2) ----------------------
  appendTimelineEvent(e: TimelineEvent): void {
    this.db
      .prepare(
        `INSERT INTO timeline_events
           (id, created_at, session_id, at_ms, end_ms, type, severity, confidence, source, description, linked_text)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id, e.createdAt, e.sessionId, e.atMs, e.endMs, e.type, e.severity, e.confidence, e.source,
        e.description, e.linkedText,
      );
  }
  listTimeline(sessionId: Id): TimelineEvent[] {
    return (
      this.db.prepare(`SELECT * FROM timeline_events WHERE session_id = ? ORDER BY at_ms, created_at`).all(sessionId) as Row[]
    ).map((r) => ({
      id: String(r.id),
      createdAt: Number(r.created_at),
      sessionId: String(r.session_id),
      atMs: Number(r.at_ms),
      endMs: r.end_ms == null ? null : Number(r.end_ms),
      type: r.type as TimelineEvent['type'],
      severity: r.severity as TimelineEvent['severity'],
      confidence: r.confidence as TimelineEvent['confidence'],
      source: r.source as TimelineEvent['source'],
      description: String(r.description),
      linkedText: (r.linked_text as string | null) ?? null,
    }));
  }

  // --- judge evaluations (Phase 2) -------------------
  createEvaluation(e: JudgeEvaluation): JudgeEvaluation {
    this.db
      .prepare(
        `INSERT INTO judge_evaluations
           (id, created_at, session_id, rubric_id, rubric_name, judge_type, judge_id, status,
            scale_max, overall_score, overall_confidence, criteria, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        e.id, e.createdAt, e.sessionId, e.rubricId, e.rubricName, e.judgeType, e.judgeId, e.status,
        e.scaleMax, e.overallScore, e.overallConfidence, j(e.criteria), e.notes,
      );
    return e;
  }
  getEvaluation(id: Id): JudgeEvaluation | null {
    const r = this.db.prepare(`SELECT * FROM judge_evaluations WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToEval(r) : null;
  }
  updateEvaluation(e: JudgeEvaluation): void {
    this.db
      .prepare(
        `UPDATE judge_evaluations
           SET status = ?, judge_type = ?, judge_id = ?, scale_max = ?, overall_score = ?,
               overall_confidence = ?, criteria = ?, notes = ?
         WHERE id = ?`,
      )
      .run(
        e.status, e.judgeType, e.judgeId, e.scaleMax, e.overallScore, e.overallConfidence,
        j(e.criteria), e.notes, e.id,
      );
  }
  listEvaluations(sessionId: Id): JudgeEvaluation[] {
    return (
      this.db.prepare(`SELECT * FROM judge_evaluations WHERE session_id = ? ORDER BY created_at`).all(sessionId) as Row[]
    ).map((r) => this.rowToEval(r));
  }
  private rowToEval(r: Row): JudgeEvaluation {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      sessionId: String(r.session_id),
      rubricId: String(r.rubric_id),
      rubricName: String(r.rubric_name),
      judgeType: r.judge_type as JudgeEvaluation['judgeType'],
      judgeId: (r.judge_id as string | null) ?? null,
      status: r.status as JudgeEvaluation['status'],
      scaleMax: Number(r.scale_max),
      overallScore: Number(r.overall_score),
      overallConfidence: r.overall_confidence as JudgeEvaluation['overallConfidence'],
      criteria: p(r.criteria),
      notes: (r.notes as string | null) ?? null,
    };
  }

  // --- integrity (Phase 3) -------------------------------
  createIntegrityCase(c: IntegrityCase): IntegrityCase {
    this.db
      .prepare(
        `INSERT INTO integrity_cases
           (id, created_at, session_id, event_id, participant_id, policy_snapshot, risk_level, confidence,
            signals, source_matches, participant_matches, style_analysis, preparedness, session_integrity,
            recommendation, not_proved_note, search_coverage, status, review)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        c.id, c.createdAt, c.sessionId, c.eventId, c.participantId, j(c.policySnapshot), c.riskLevel, c.confidence,
        j(c.signals), j(c.sourceMatches), j(c.participantMatches), j(c.styleAnalysis), j(c.preparedness),
        j(c.sessionIntegrity), c.recommendation, c.notProvedNote, c.searchCoverage, c.status,
        c.review ? j(c.review) : null,
      );
    return c;
  }
  getIntegrityCase(id: Id): IntegrityCase | null {
    const r = this.db.prepare(`SELECT * FROM integrity_cases WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToIntegrityCase(r) : null;
  }
  updateIntegrityCase(c: IntegrityCase): void {
    this.db
      .prepare(`UPDATE integrity_cases SET risk_level = ?, confidence = ?, status = ?, review = ? WHERE id = ?`)
      .run(c.riskLevel, c.confidence, c.status, c.review ? j(c.review) : null, c.id);
  }
  listIntegrityCasesBySession(sessionId: Id): IntegrityCase[] {
    return (this.db.prepare(`SELECT * FROM integrity_cases WHERE session_id = ? ORDER BY created_at DESC`).all(sessionId) as Row[]).map(
      (r) => this.rowToIntegrityCase(r),
    );
  }
  listIntegrityCasesByEvent(eventId: Id): IntegrityCase[] {
    return (this.db.prepare(`SELECT * FROM integrity_cases WHERE event_id = ? ORDER BY created_at DESC`).all(eventId) as Row[]).map(
      (r) => this.rowToIntegrityCase(r),
    );
  }
  private rowToIntegrityCase(r: Row): IntegrityCase {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      sessionId: String(r.session_id),
      eventId: (r.event_id as string | null) ?? null,
      participantId: (r.participant_id as string | null) ?? null,
      policySnapshot: p(r.policy_snapshot),
      riskLevel: r.risk_level as IntegrityCase['riskLevel'],
      confidence: r.confidence as IntegrityCase['confidence'],
      signals: p(r.signals),
      sourceMatches: p(r.source_matches),
      participantMatches: p(r.participant_matches),
      styleAnalysis: r.style_analysis == null ? null : p(r.style_analysis),
      preparedness: p(r.preparedness),
      sessionIntegrity: p(r.session_integrity),
      recommendation: String(r.recommendation),
      notProvedNote: String(r.not_proved_note),
      searchCoverage: String(r.search_coverage),
      status: r.status as IntegrityCase['status'],
      review: r.review == null ? null : p(r.review),
    };
  }

  createIntegrityAnalytics(a: IntegrityAnalytics): IntegrityAnalytics {
    this.db
      .prepare(
        `INSERT INTO integrity_analytics
           (id, created_at, session_id, event_id, source_match_count, cross_participant_max,
            distinctive_phrases_checked, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.createdAt, a.sessionId, a.eventId, a.sourceMatchCount, a.crossParticipantMax, a.distinctivePhrasesChecked, a.note);
    return a;
  }
  listIntegrityAnalyticsBySession(sessionId: Id): IntegrityAnalytics[] {
    return (this.db.prepare(`SELECT * FROM integrity_analytics WHERE session_id = ? ORDER BY created_at`).all(sessionId) as Row[]).map(
      (r) => ({
        id: String(r.id),
        createdAt: Number(r.created_at),
        sessionId: String(r.session_id),
        eventId: (r.event_id as string | null) ?? null,
        sourceMatchCount: Number(r.source_match_count),
        crossParticipantMax: Number(r.cross_participant_max),
        distinctivePhrasesChecked: Number(r.distinctive_phrases_checked),
        note: String(r.note),
      }),
    );
  }

  // --- style baselines (Phase 4) -------------------------
  upsertStyleBaseline(b: StyleBaseline): StyleBaseline {
    this.db
      .prepare(
        `INSERT INTO style_baselines (id, created_at, participant_id, sessions_used, metrics, spread)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(b.id, b.createdAt, b.participantId, b.sessionsUsed, j(b.metrics), j(b.spread));
    return b;
  }
  latestStyleBaseline(participantId: Id): StyleBaseline | null {
    const r = this.db
      .prepare(`SELECT * FROM style_baselines WHERE participant_id = ? ORDER BY created_at DESC LIMIT 1`)
      .get(participantId) as Row | undefined;
    return r
      ? {
          id: String(r.id),
          createdAt: Number(r.created_at),
          participantId: String(r.participant_id),
          sessionsUsed: Number(r.sessions_used),
          metrics: p(r.metrics),
          spread: p(r.spread),
        }
      : null;
  }

  // --- session artifacts (Phase 4) ----------------------
  putSessionArtifacts(a: SessionArtifacts): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO session_artifacts
           (id, created_at, session_id, transcript_hash, snapshot_hash, timeline_hash, segment_count, audio_ms_total, reconnects)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.createdAt, a.sessionId, a.transcriptHash, a.snapshotHash, a.timelineHash, a.segmentCount, a.audioMsTotal, a.reconnects);
  }
  getSessionArtifacts(sessionId: Id): SessionArtifacts | null {
    const r = this.db.prepare(`SELECT * FROM session_artifacts WHERE session_id = ?`).get(sessionId) as Row | undefined;
    return r
      ? {
          id: String(r.id),
          createdAt: Number(r.created_at),
          sessionId: String(r.session_id),
          transcriptHash: String(r.transcript_hash),
          snapshotHash: String(r.snapshot_hash),
          timelineHash: String(r.timeline_hash),
          segmentCount: Number(r.segment_count),
          audioMsTotal: Number(r.audio_ms_total),
          reconnects: Number(r.reconnects),
        }
      : null;
  }

  // --- appeals (Phase 4) --------------------------------
  createAppeal(a: IntegrityAppeal): IntegrityAppeal {
    this.db
      .prepare(
        `INSERT INTO integrity_appeals (id, created_at, case_id, session_id, submitted_by, statement, source_attribution, response)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(a.id, a.createdAt, a.caseId, a.sessionId, a.submittedBy, a.statement, a.sourceAttribution, a.response ? j(a.response) : null);
    return a;
  }
  getAppeal(id: Id): IntegrityAppeal | null {
    const r = this.db.prepare(`SELECT * FROM integrity_appeals WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToAppeal(r) : null;
  }
  updateAppeal(a: IntegrityAppeal): void {
    this.db.prepare(`UPDATE integrity_appeals SET response = ? WHERE id = ?`).run(a.response ? j(a.response) : null, a.id);
  }
  listAppealsByCase(caseId: Id): IntegrityAppeal[] {
    return (this.db.prepare(`SELECT * FROM integrity_appeals WHERE case_id = ? ORDER BY created_at`).all(caseId) as Row[]).map((r) =>
      this.rowToAppeal(r),
    );
  }
  private rowToAppeal(r: Row): IntegrityAppeal {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      caseId: String(r.case_id),
      sessionId: String(r.session_id),
      submittedBy: String(r.submitted_by),
      statement: String(r.statement),
      sourceAttribution: (r.source_attribution as string | null) ?? null,
      response: r.response == null ? null : p(r.response),
    };
  }

  // --- coaching (Phase 6) -------------------------------
  createCoachPlan(p: CoachPlan): CoachPlan {
    this.db
      .prepare(
        `INSERT INTO coach_plans
           (id, created_at, session_id, participant_id, evaluation_id, persona, overall_score,
            scale_max, focus_areas, weaknesses, summary, keep_doing)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        p.id, p.createdAt, p.sessionId, p.participantId, p.evaluationId, p.persona, p.overallScore,
        p.scaleMax, j(p.focusAreas), j(p.weaknesses), p.summary, j(p.keepDoing),
      );
    return p;
  }
  getCoachPlan(id: Id): CoachPlan | null {
    const r = this.db.prepare(`SELECT * FROM coach_plans WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToCoachPlan(r) : null;
  }
  listCoachPlansBySession(sessionId: Id): CoachPlan[] {
    return (this.db.prepare(`SELECT * FROM coach_plans WHERE session_id = ? ORDER BY created_at DESC`).all(sessionId) as Row[]).map(
      (r) => this.rowToCoachPlan(r),
    );
  }
  private rowToCoachPlan(r: Row): CoachPlan {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      sessionId: String(r.session_id),
      participantId: (r.participant_id as string | null) ?? null,
      evaluationId: String(r.evaluation_id),
      persona: r.persona as CoachPlan['persona'],
      overallScore: Number(r.overall_score),
      scaleMax: Number(r.scale_max),
      focusAreas: p(r.focus_areas),
      weaknesses: p(r.weaknesses),
      summary: String(r.summary),
      keepDoing: p(r.keep_doing),
    };
  }

  createDrill(d: Drill): Drill {
    this.db
      .prepare(
        `INSERT INTO drills
           (id, created_at, plan_id, session_id, participant_id, type, difficulty, from_weakness,
            prompt, time_limit_sec, status, response_session_id, exchanges, grade)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        d.id, d.createdAt, d.planId, d.sessionId, d.participantId, d.type, d.difficulty, d.fromWeakness,
        d.prompt, d.timeLimitSec, d.status, d.responseSessionId, j(d.exchanges), d.grade ? j(d.grade) : null,
      );
    return d;
  }
  getDrill(id: Id): Drill | null {
    const r = this.db.prepare(`SELECT * FROM drills WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToDrill(r) : null;
  }
  updateDrill(d: Drill): void {
    this.db
      .prepare(`UPDATE drills SET difficulty = ?, status = ?, response_session_id = ?, exchanges = ?, grade = ? WHERE id = ?`)
      .run(d.difficulty, d.status, d.responseSessionId, j(d.exchanges), d.grade ? j(d.grade) : null, d.id);
  }
  listDrillsByPlan(planId: Id): Drill[] {
    return (this.db.prepare(`SELECT * FROM drills WHERE plan_id = ? ORDER BY created_at`).all(planId) as Row[]).map((r) =>
      this.rowToDrill(r),
    );
  }
  private rowToDrill(r: Row): Drill {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      planId: (r.plan_id as string | null) ?? null,
      sessionId: String(r.session_id),
      participantId: (r.participant_id as string | null) ?? null,
      type: r.type as Drill['type'],
      difficulty: r.difficulty as Drill['difficulty'],
      fromWeakness: String(r.from_weakness),
      prompt: String(r.prompt),
      timeLimitSec: Number(r.time_limit_sec),
      status: r.status as Drill['status'],
      responseSessionId: (r.response_session_id as string | null) ?? null,
      exchanges: p(r.exchanges),
      grade: r.grade == null ? null : p(r.grade),
    };
  }

  // --- users (Phase 7) ---------------------------------
  createUser(u: User): User {
    this.db
      .prepare(`INSERT INTO users (id, created_at, name, email, role, participant_id, password_hash) VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(u.id, u.createdAt, u.name, u.email, u.role, u.participantId, u.passwordHash);
    return u;
  }
  getUser(id: Id): User | null {
    const r = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as Row | undefined;
    return r ? this.rowToUser(r) : null;
  }
  getUserByEmail(email: string): User | null {
    const r = this.db.prepare(`SELECT * FROM users WHERE email = ?`).get(email.toLowerCase()) as Row | undefined;
    return r ? this.rowToUser(r) : null;
  }
  listUsers(): User[] {
    return (this.db.prepare(`SELECT * FROM users ORDER BY created_at`).all() as Row[]).map((r) => this.rowToUser(r));
  }
  countUsers(): number {
    return Number((this.db.prepare(`SELECT count(*) c FROM users`).get() as Row).c);
  }
  private rowToUser(r: Row): User {
    return {
      id: String(r.id),
      createdAt: Number(r.created_at),
      name: String(r.name),
      email: (r.email as string | null) ?? null,
      role: r.role as User['role'],
      participantId: (r.participant_id as string | null) ?? null,
      passwordHash: String(r.password_hash),
    };
  }

  listAuditByEvent(eventId: Id): AuditEvent[] {
    return (this.db.prepare(`SELECT * FROM audit_events WHERE event_id = ? ORDER BY created_at`).all(eventId) as Row[]).map((r) => ({
      id: String(r.id),
      createdAt: Number(r.created_at),
      actor: String(r.actor),
      action: String(r.action),
      objectType: String(r.object_type),
      objectId: String(r.object_id),
      sessionId: (r.session_id as string | null) ?? null,
      eventId: (r.event_id as string | null) ?? null,
      prev: r.prev == null ? null : p(r.prev),
      next: r.next == null ? null : p(r.next),
    }));
  }

  close(): void {
    this.db.close();
  }
}
