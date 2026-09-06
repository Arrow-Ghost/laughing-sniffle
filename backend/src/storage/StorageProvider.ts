// Persistence boundary. Everything durable goes through this interface so the
// backing store (SQLite now, Postgres later) is swappable — same pattern the
// spec asks for around SourceSearchProvider (§84, §119).

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

export interface StorageProvider {
  // --- events -------------------------------------------------------------
  createEvent(e: Event): Event;
  getEvent(id: Id): Event | null;
  listEvents(): Event[];
  setEventStatus(id: Id, status: EventStatus): void;
  setEventRubric(id: Id, rubricId: Id): void;

  // --- rounds ------------------------------------------------------------
  createRound(r: Round): Round;
  getRound(id: Id): Round | null;
  listRoundsByEvent(eventId: Id): Round[];

  // --- participants ----------------------------------------------------
  createParticipant(p: Participant): Participant;
  getParticipant(id: Id): Participant | null;
  listParticipantsByEvent(eventId: Id): Participant[];

  // --- sessions --------------------------------------------------------
  createSession(s: Session): Session;
  getSession(id: Id): Session | null;
  listSessions(opts?: { eventId?: Id; limit?: number }): Session[];
  endSession(id: Id, endedAt: number): void;

  // --- transcript ----------------------------------------------------
  appendSegment(seg: TranscriptSegment): void;
  listSegments(sessionId: Id): TranscriptSegment[];

  // --- speech metrics ----------------------------------------------
  appendMetric(m: SpeechMetric): void;
  latestMetric(sessionId: Id): SpeechMetric | null;
  listMetrics(sessionId: Id): SpeechMetric[];

  // --- audit -------------------------------------------------------
  appendAudit(a: AuditEvent): void;
  listAuditBySession(sessionId: Id): AuditEvent[];

  // --- rubrics (Phase 2) ---------------------------------------
  createRubric(r: Rubric): Rubric;
  getRubric(id: Id): Rubric | null;
  listRubrics(opts?: { eventId?: Id }): Rubric[];

  // --- timeline events (Phase 2) -----------------------------
  appendTimelineEvent(e: TimelineEvent): void;
  listTimeline(sessionId: Id): TimelineEvent[];

  // --- judge evaluations (Phase 2) --------------------------
  createEvaluation(e: JudgeEvaluation): JudgeEvaluation;
  getEvaluation(id: Id): JudgeEvaluation | null;
  updateEvaluation(e: JudgeEvaluation): void;
  listEvaluations(sessionId: Id): JudgeEvaluation[];

  // --- integrity (Phase 3) --------------------------------
  createIntegrityCase(c: IntegrityCase): IntegrityCase;
  getIntegrityCase(id: Id): IntegrityCase | null;
  updateIntegrityCase(c: IntegrityCase): void;
  listIntegrityCasesBySession(sessionId: Id): IntegrityCase[];
  listIntegrityCasesByEvent(eventId: Id): IntegrityCase[];
  createIntegrityAnalytics(a: IntegrityAnalytics): IntegrityAnalytics;
  listIntegrityAnalyticsBySession(sessionId: Id): IntegrityAnalytics[];

  // --- Phase 4 --------------------------------------------
  upsertStyleBaseline(b: StyleBaseline): StyleBaseline;
  latestStyleBaseline(participantId: Id): StyleBaseline | null;
  putSessionArtifacts(a: SessionArtifacts): void;
  getSessionArtifacts(sessionId: Id): SessionArtifacts | null;
  createAppeal(a: IntegrityAppeal): IntegrityAppeal;
  getAppeal(id: Id): IntegrityAppeal | null;
  updateAppeal(a: IntegrityAppeal): void;
  listAppealsByCase(caseId: Id): IntegrityAppeal[];

  // --- Phase 6: coaching -----------------------------------
  createCoachPlan(p: CoachPlan): CoachPlan;
  getCoachPlan(id: Id): CoachPlan | null;
  listCoachPlansBySession(sessionId: Id): CoachPlan[];
  createDrill(d: Drill): Drill;
  getDrill(id: Id): Drill | null;
  updateDrill(d: Drill): void;
  listDrillsByPlan(planId: Id): Drill[];

  // --- Phase 7: users -------------------------------------
  createUser(u: User): User;
  getUser(id: Id): User | null;
  getUserByEmail(email: string): User | null;
  listUsers(): User[];
  countUsers(): number;

  // --- Phase 7: cross-cutting reads ---------------------
  listAuditByEvent(eventId: Id): AuditEvent[];

  close(): void;
}
