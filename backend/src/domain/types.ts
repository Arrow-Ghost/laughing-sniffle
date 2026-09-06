// Core domain types. Everything durable chains back to a Session (spec §71).
// Phase 1 covers the foundation entities only; Judge / Integrity / Coach types
// arrive with their phases.

export type Id = string;

export interface Entity {
  id: Id;
  createdAt: number; // epoch ms
}

export type EventType =
  | 'debate'
  | 'interview'
  | 'speech'
  | 'presentation'
  | 'hackathon-pitch'
  | 'mun'
  | 'panel'
  | 'custom';

export type EventStatus = 'draft' | 'active' | 'complete' | 'archived';

export type PolicyStance = 'allowed' | 'disclosure' | 'restricted' | 'prohibited';
export type BinaryPolicy = 'allowed' | 'prohibited';

/** Controls how aggressively the Integrity Engine interprets signals (spec §16, §97–99). */
export interface EventPolicy {
  aiAssistance: PolicyStance;
  internet: BinaryPolicy;
  preparedNotes: BinaryPolicy;
  externalSources: BinaryPolicy;
  maxDurationSec: number | null;
  languages: string[]; // BCP-47 tags; [] = unrestricted
  integrityReview: boolean;
}

export interface Event extends Entity {
  name: string;
  type: EventType;
  description: string;
  status: EventStatus;
  policy: EventPolicy;
  rubricId: Id | null;
}

export type RoundStatus = 'pending' | 'active' | 'complete';

export interface Round extends Entity {
  eventId: Id;
  index: number; // 1-based
  name: string;
  status: RoundStatus;
}

export interface Participant extends Entity {
  eventId: Id | null; // null = standalone practice
  displayName: string;
  seat: string | null; // e.g. "Proposition 1", "Candidate"
}

export type SessionMode = 'debate-practice' | 'interview-prep' | 'speech-coaching';
export type SessionStatus = 'live' | 'ended';

export interface Consent {
  speakerAcknowledged: boolean;
  secondPartyAcknowledged: boolean;
  acknowledgedAt: string; // ISO
}

export interface Session extends Entity {
  eventId: Id | null;
  roundId: Id | null;
  participantId: Id | null;
  mode: SessionMode;
  label: string;
  consent: Consent;
  status: SessionStatus;
  startedAt: number | null;
  endedAt: number | null;
  languages: string[]; // expected spoken languages (BCP-47); [] = auto / unrestricted
  expectSpeakers: number; // 1 = single speaker; >1 enables best-effort diarization
}

export type TranscriptSource = 'gemini' | 'browser';

export interface TranscriptSegment extends Entity {
  sessionId: Id;
  source: TranscriptSource;
  t0: number; // ms into session audio
  t1: number;
  text: string;
  isFinal: boolean;
  lang: string | null; // BCP-47, populated when multilingual transcription is on
  speakerId: Id | null; // best-effort diarization label id
}

/* --------------------------- Phase 5: multilingual --------------------------- */
//
// The ORIGINAL transcript is authoritative. Translation is added alongside, never
// in place (spec §12). Code-switching is described, not penalised — whether a
// language matters is Event Policy's call (spec §13). Diarization is best-effort
// and always flagged low-confidence (no local diarizer available).

export interface LanguageSpan {
  start: number; // ms
  end: number;
  lang: string;
  text: string;
}

export interface LanguageProfile {
  primary: string;
  languages: Array<{ lang: string; share: number; spans: number }>;
  switches: number;
  codeSwitching: boolean;
  outsidePolicy: string[]; // languages spoken that the event does not list (a note, not a flag)
}

export interface SpeakerSummary {
  id: Id;
  label: string; // "Speaker A", "Moderator", ...
  segmentCount: number;
  speakingMs: number;
  turns: number;
}

export interface DiarizationResult {
  speakers: SpeakerSummary[];
  confidence: 'low'; // always — best-effort, from the transcription model only
  note: string;
}

export interface TranslatedSegment {
  t0: number;
  t1: number;
  lang: string | null;
  text: string; // original — unchanged
  translation: string | null; // added alongside
  speakerId: Id | null;
}

/** A point-in-time descriptive snapshot from the Speech Core. Blob kept as-is. */
export interface SpeechMetric extends Entity {
  sessionId: Id;
  atMs: number;
  kind: 'periodic' | 'final';
  snapshot: unknown;
}

export interface AuditEvent extends Entity {
  actor: string; // "system", or a userId once auth lands
  action: string; // "session.started", "transcript.finalized", ...
  objectType: string;
  objectId: Id;
  sessionId: Id | null;
  eventId: Id | null;
  prev: unknown | null;
  next: unknown | null;
}

/* ---------------------------- Phase 2: judging --------------------------- */

export type Confidence = 'low' | 'medium' | 'high';

/** A single scored dimension of a rubric (spec §17, §18). Never hardcoded. */
export interface RubricCriterion {
  id: string;
  name: string;
  weight: number; // 0..1; a rubric's criteria weights sum to ~1
  description: string;
  scaleMin: number;
  scaleMax: number;
  anchors: Record<string, string>; // { "1": "extremely weak", "5": "adequate", ... }
  evaluationRules: string; // guidance handed to the judge
  dimension: string | null; // optional grouping label
}

export interface Rubric extends Entity {
  eventId: Id | null;
  name: string;
  eventType: EventType;
  criteria: RubricCriterion[];
}

/** A pointer into the transcript backing a score (spec §20, §21). */
export interface EvidenceRef {
  startMs: number;
  endMs: number;
  quote: string;
  reason: string;
}

/** One criterion's result. Carries both the AI score and any human override
 *  so the decision is auditable (spec §50, §94). `score` is the effective one. */
export interface CriterionScore {
  criterionId: string;
  criterionName: string;
  weight: number;
  score: number;
  aiScore: number | null;
  humanScore: number | null;
  confidence: Confidence;
  confidenceReasons: string[];
  evidence: EvidenceRef[];
  strengths: string[];
  weaknesses: string[];
  reasoning: string;
  overriddenBy: string | null;
  overrideReason: string | null;
}

export type JudgeType = 'ai' | 'human';
export type EvaluationStatus = 'draft' | 'final';

/** Performance evaluation only. Deliberately carries NO integrity field —
 *  performance and integrity are separate concepts (spec §101). */
export interface JudgeEvaluation extends Entity {
  sessionId: Id;
  rubricId: Id;
  rubricName: string;
  judgeType: JudgeType;
  judgeId: string | null;
  status: EvaluationStatus;
  scaleMax: number;
  overallScore: number;
  overallConfidence: Confidence;
  criteria: CriterionScore[];
  notes: string | null;
}

export type TimelineEventType =
  | 'question'
  | 'pause'
  | 'long-pause'
  | 'pace-shift'
  | 'strong-moment'
  | 'weakness'
  | 'claim'
  | 'evidence'
  | 'rebuttal'
  | 'time-warning'
  | 'source-match'
  | 'cross-match'
  | 'ai-signal'
  | 'language-switch';

export type TimelineSeverity = 'info' | 'notable' | 'concern';
export type TimelineSource = 'speech-core' | 'judge' | 'integrity';

/** The universal, persisted evidence timeline (spec §21). Neutral observations —
 *  "notable"/"concern" describe salience for a reviewer, never a verdict. */
export interface TimelineEvent extends Entity {
  sessionId: Id;
  atMs: number;
  endMs: number | null;
  type: TimelineEventType;
  severity: TimelineSeverity;
  confidence: Confidence;
  source: TimelineSource;
  description: string;
  linkedText: string | null;
}

/* --------------------------- Phase 3: integrity -------------------------- */
//
// Integrity is a SEPARATE concept from performance (spec §2, §101). Nothing here
// feeds a score. The output is: risk LEVEL + evidence + reason + recommended
// action — never a probability, never a claim that AI/plagiarism is proven
// (spec §3). Only a human reviewer can move a case to "confirmed".

export type RiskLevel = 'LOW' | 'MODERATE' | 'HIGH' | 'CRITICAL';

export type SourceType =
  | 'academic'
  | 'government'
  | 'news'
  | 'reference'
  | 'corporate'
  | 'blog'
  | 'forum'
  | 'social'
  | 'unknown';

export type QuotationClass =
  | 'original'
  | 'copied'
  | 'quoted'
  | 'paraphrased'
  | 'common-knowledge'
  | 'attributed'
  | 'uncertain';

export interface SourceMatch {
  phrase: string;
  atMs: number | null;
  sourceUrl: string;
  domain: string;
  title: string;
  sourceType: SourceType;
  credibility: number; // 0..1
  exactSimilarity: number; // 0..1 (shingle containment)
  phraseUniqueness: number; // 0..1
  quotationClass: QuotationClass;
  significance: number; // 0..1 combined
  viaTranslation: boolean; // matched against a translated transcript → lower confidence (spec §12)
}

export interface ParticipantMatch {
  otherSessionId: Id;
  otherLabel: string;
  sharedDistinctivePhrases: string[];
  similarity: number; // 0..1
  note: string;
}

/** One independently-sourced signal (spec §36). The aggregator combines several;
 *  no single one can reach HIGH on its own (spec §39). */
export interface IntegritySignal {
  key: string;
  label: string;
  present: boolean;
  strength: number; // 0..1
  origin: string; // the independent source of this signal
  evidence: string[];
}

export type ReviewDecision = 'dismiss' | 'monitor' | 'investigate' | 'confirm';
export type IntegrityCaseStatus =
  | 'pending_review'
  | 'dismissed'
  | 'monitoring'
  | 'investigating'
  | 'confirmed';

export interface IntegrityReview {
  reviewerId: string;
  decision: ReviewDecision;
  reason: string;
  notes: string | null;
  at: number;
}

export interface IntegrityCase extends Entity {
  sessionId: Id;
  eventId: Id | null;
  participantId: Id | null;
  policySnapshot: EventPolicy;
  riskLevel: RiskLevel;
  confidence: Confidence;
  signals: IntegritySignal[];
  sourceMatches: SourceMatch[];
  participantMatches: ParticipantMatch[];
  styleAnalysis: StyleDeviation | null; // spec §37 — probabilistic evidence only
  preparedness: PreparednessAnalysis; // spec §38 — an observation, not a verdict
  sessionIntegrity: SessionIntegrityReport; // spec §44-46 — anomalies, never "tampered"
  recommendation: string;
  notProvedNote: string; // "what this evidence does NOT establish" (spec §41)
  searchCoverage: string; // honest wording about what was actually searched (spec §86)
  status: IntegrityCaseStatus;
  review: IntegrityReview | null;
}

/* --- style baseline (spec §37) --- */

export interface StyleMetrics {
  meanUnitLength: number;
  vocabularyVariety: number; // MATTR
  longWordRate: number;
  fillerPerMin: number;
  pausesPerMin: number;
  wpm: number;
}

export interface StyleBaseline extends Entity {
  participantId: Id;
  sessionsUsed: number;
  metrics: StyleMetrics;
  spread: StyleMetrics; // per-metric sample sd used for z-scores
}

export interface StyleDeviation {
  hasBaseline: boolean;
  sessionsInBaseline: number;
  perMetric: Array<{ metric: string; current: number; baseline: number; z: number }>;
  overallShift: number; // 0..1
  reasons: string[];
  caveat: string; // spec §37 — transcription artefacts distort speech style analysis
}

/* --- preparedness (spec §38) --- */

export type PreparednessClass = 'spontaneous' | 'prepared' | 'highly-rehearsed' | 'uncertain';

export interface PreparednessAnalysis {
  classification: PreparednessClass;
  rehearsedScore: number; // 0..1 how rehearsed it looks
  indicators: string[];
  note: string; // "prepared is not the same as AI-assisted"
}

/* --- session integrity (spec §44-46) --- */

export type SessionAnomalyType =
  | 'timestamp-discontinuity'
  | 'duplicated-segment'
  | 'audio-stream-gap'
  | 'reconnect'
  | 'timing-inconsistent-with-audio'
  | 'hash-mismatch';

export interface SessionIntegrityAnomaly {
  type: SessionAnomalyType;
  atMs: number | null;
  severity: 'info' | 'notable' | 'concern';
  detail: string;
}

export interface SessionArtifacts extends Entity {
  sessionId: Id;
  transcriptHash: string; // sha-256 hex
  snapshotHash: string;
  timelineHash: string;
  segmentCount: number;
  audioMsTotal: number;
  reconnects: number;
}

export interface SessionIntegrityReport {
  hashed: boolean;
  transcriptHash: string | null;
  anomalies: SessionIntegrityAnomaly[];
  note: string; // spec §47 — honest about what browser capture can and cannot guarantee
}

/* --- appeals (spec §43) --- */

export interface AppealResponse {
  reviewerId: string;
  decision: 'upheld' | 'partially-upheld' | 'rejected';
  reason: string;
  at: number;
}

export interface IntegrityAppeal extends Entity {
  caseId: Id;
  sessionId: Id;
  submittedBy: string;
  statement: string;
  sourceAttribution: string | null;
  response: AppealResponse | null;
}

/* --- source graph (spec §62) --- */

export interface GraphNode {
  id: string;
  kind: 'participant' | 'source' | 'other-participant';
  label: string;
  meta?: Record<string, unknown>;
}
export interface GraphEdge {
  from: string;
  to: string;
  kind: 'phrase-similarity' | 'semantic-similarity' | 'argument-similarity';
  weight: number;
  evidence: string;
}
export interface SourceGraph {
  caseId: Id;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

/** Recorded instead of a case when the event's policy allows AI assistance —
 *  disclosure analytics only, never a flag (spec §97). */
export interface IntegrityAnalytics extends Entity {
  sessionId: Id;
  eventId: Id | null;
  sourceMatchCount: number;
  crossParticipantMax: number;
  distinctivePhrasesChecked: number;
  note: string;
}

export const DEFAULT_POLICY: EventPolicy = {
  aiAssistance: 'prohibited',
  internet: 'prohibited',
  preparedNotes: 'allowed',
  externalSources: 'prohibited',
  maxDurationSec: null,
  languages: [],
  integrityReview: true,
};

/* ---------------------------- Phase 6: coaching ---------------------------- */
//
// Coaching consumes the Judge Engine's exact weaknesses — verbatim, not
// re-generated (spec §89). A plan points at drills; a drill's response is its
// own recorded session so the whole pipeline applies; grading is a focused
// single-criterion pass. Personas change wording only, never scoring (spec §59).

export type CoachPersona =
  | 'supportive'
  | 'analytical'
  | 'strict'
  | 'executive'
  | 'debate-coach'
  | 'interview-coach';

export type DrillType =
  | 'rebuttal-sprint'
  | 'evidence-challenge'
  | 'conciseness-drill'
  | 'signposting-drill'
  | 'pace-drill'
  | 'poi-gauntlet'
  | 'cross-examination'
  | 'pressure-drill'
  | 'interview-drill'
  | 'retry';

export type DrillDifficulty = 'beginner' | 'intermediate' | 'advanced' | 'expert';

export interface CoachWeakness {
  criterionId: string;
  criterionName: string;
  score: number;
  weaknessText: string; // VERBATIM from JudgeEvaluation.criteria[].weaknesses (spec §89)
  evidence: Array<{ startMs: number; endMs: number; quote: string }>;
  suggestedDrill: DrillType;
}

export interface CoachPlan extends Entity {
  sessionId: Id;
  participantId: Id | null;
  evaluationId: Id;
  persona: CoachPersona;
  overallScore: number;
  scaleMax: number;
  focusAreas: string[]; // lowest-scoring criteria
  weaknesses: CoachWeakness[];
  summary: string; // generated, but grounded in the weaknesses above
  keepDoing: string[];
}

export interface DrillGrade {
  score: number;
  scaleMax: number;
  targetMet: boolean;
  feedback: string;
  suggestedNextDifficulty: DrillDifficulty;
}

export interface DrillExchange {
  role: 'participant' | 'opponent';
  text: string;
  at: number;
}

export interface Drill extends Entity {
  planId: Id | null;
  sessionId: Id; // the session the weakness came from
  participantId: Id | null;
  type: DrillType;
  difficulty: DrillDifficulty;
  fromWeakness: string; // the criterionName / weakness this drill targets
  prompt: string; // the challenge shown to the participant
  timeLimitSec: number;
  status: 'ready' | 'active' | 'complete';
  responseSessionId: Id | null; // the recorded attempt
  exchanges: DrillExchange[]; // AI-opponent memory (spec §57)
  grade: DrillGrade | null;
}

export interface OpponentConfig {
  difficulty: DrillDifficulty;
  aggression: 'measured' | 'firm' | 'aggressive';
  domain: string;
  style: 'analytical' | 'rhetorical' | 'evidence-heavy' | 'socratic';
  language: string;
}

export interface ProgressPoint {
  sessionId: Id;
  at: number;
  label: string;
  overallScore: number | null;
  scaleMax: number | null;
  wpm: number | null;
  fillerPerMin: number | null;
  pausePerMin: number | null;
  vocabularyVariety: number | null;
}

export interface BeforeAfter {
  beforeSessionId: Id;
  afterSessionId: Id;
  criteria: Array<{ criterionName: string; before: number | null; after: number | null; delta: number | null }>;
  metrics: Array<{ metric: string; before: number | null; after: number | null; delta: number | null }>;
  overall: { before: number | null; after: number | null; delta: number | null };
}

/* --------------------------- Phase 7: competition OS --------------------------- */
//
// Consensus combines multiple judges of ONE session (spec §49). It never touches
// integrity — performance and integrity stay separate (spec §101). Divergence is
// surfaced for a human, not auto-resolved. The tie-break engine is deterministic
// and every tie it breaks records the rule that broke it (spec §51). The public
// leaderboard shows a STATUS LABEL only — never a risk level, never a signal
// (spec §53, §88).

export interface JudgeContribution {
  evaluationId: Id;
  judgeType: JudgeType;
  judgeId: string | null;
  overallScore: number;
  status: EvaluationStatus;
}

export interface CriterionConsensus {
  criterionId: string;
  criterionName: string;
  weight: number;
  mean: number;
  min: number;
  max: number;
  spread: number; // max - min
  stddev: number;
  diverges: boolean; // spread beyond the agreement band → a human should look
  perJudge: Array<{ evaluationId: Id; judgeId: string | null; score: number }>;
}

export interface SessionConsensus {
  sessionId: Id;
  rubricId: Id | null;
  rubricName: string | null;
  scaleMax: number;
  judgeCount: number;
  humanJudgeCount: number;
  contributions: JudgeContribution[];
  overallMean: number;
  overallSpread: number;
  overallStddev: number;
  agreement: 'strong' | 'moderate' | 'weak'; // qualitative label on the spread
  divergentCriteria: string[]; // criterionName[] where judges disagree materially
  outlierJudges: Array<{ evaluationId: Id; judgeId: string | null; meanDeviation: number }>;
  criteria: CriterionConsensus[];
  note: string;
}

export interface TieBreakEntry {
  participantId: Id;
  participantLabel: string;
  rank: number;
  overallScore: number;
  tiedWithPrevious: boolean;
  brokenBy: string | null; // the rule that decided this entry's order vs the one above
  trace: string[]; // human-readable ordered explanation
}

export interface TieBreakResult {
  eventId: Id | null;
  roundId: Id | null;
  rulesApplied: string[];
  entries: TieBreakEntry[];
  note: string;
}

export type IntegrityStatusLabel = 'clear' | 'under-review';

export interface LeaderboardRow {
  rank: number;
  participantId: Id;
  participantLabel: string;
  sessionsScored: number;
  overallScore: number | null;
  scaleMax: number;
  // Public: this is the ONLY integrity field. Admin view adds the detail block.
  integrityStatus: IntegrityStatusLabel;
  admin?: {
    judgeCount: number;
    consensusSpread: number | null;
    agreement: 'strong' | 'moderate' | 'weak' | null;
    integrityRisk: RiskLevel | null;
    openCaseIds: Id[];
    perCriterion: Array<{ criterionName: string; mean: number }>;
  };
}

export interface Leaderboard {
  eventId: Id;
  eventName: string;
  view: 'public' | 'admin';
  generatedAt: number;
  scaleMax: number;
  rows: LeaderboardRow[];
  note: string;
}

export interface EventAnalytics {
  eventId: Id;
  eventName: string;
  generatedAt: number;
  participants: number;
  sessions: number;
  sessionsEnded: number;
  evaluations: number;
  finalEvaluations: number;
  scoreDistribution: {
    scaleMax: number;
    count: number;
    mean: number | null;
    median: number | null;
    stddev: number | null;
    histogram: Array<{ bucket: string; count: number }>;
  };
  criterionAverages: Array<{ criterionName: string; mean: number; n: number }>;
  judgeStats: Array<{
    judgeId: string;
    judgeType: JudgeType;
    evaluations: number;
    meanScoreGiven: number;
    meanDeviationFromConsensus: number; // + = more generous than the room, - = harsher
  }>;
  integritySummary: {
    cases: number;
    byRisk: Record<RiskLevel, number>;
    byStatus: Record<IntegrityCaseStatus, number>;
    confirmedByHuman: number;
    note: string;
  };
  coaching: { plans: number; drills: number; participantsWithPlan: number };
}

export interface ReplayBundle {
  bundleVersion: 1;
  generatedAt: number;
  contentHash: string; // sha-256 hex over the canonicalised body
  redacted: boolean; // true when integrity detail was stripped for a non-reviewer
  session: Session;
  participant: Participant | null;
  event: Event | null;
  rounds: Round[];
  segments: TranscriptSegment[];
  metrics: SpeechMetric[];
  timeline: TimelineEvent[];
  evaluations: JudgeEvaluation[];
  consensus: SessionConsensus | null;
  integrityCases: unknown[]; // IntegrityCase[] for a reviewer, redacted views otherwise
  coachPlans: CoachPlan[];
  artifacts: SessionArtifacts | null;
  audit: AuditEvent[];
}

export type JobKind = 'integrity.analyzeSession' | 'judge.evaluate' | 'event.analytics';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed';

export interface Job {
  id: Id;
  kind: JobKind;
  payload: Record<string, unknown>;
  status: JobStatus;
  attempts: number;
  maxAttempts: number;
  enqueuedAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  result: unknown | null;
  error: string | null;
}
