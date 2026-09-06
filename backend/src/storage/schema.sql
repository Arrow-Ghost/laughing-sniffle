-- ShadowADJ storage schema. Phase 1 foundation entities only.
-- Everything durable chains back to a session (spec §71).
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'draft',
  policy      TEXT NOT NULL,          -- JSON EventPolicy
  rubric_id   TEXT
);

CREATE TABLE IF NOT EXISTS rounds (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  event_id    TEXT NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  idx         INTEGER NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',
  UNIQUE (event_id, idx)
);

CREATE TABLE IF NOT EXISTS participants (
  id           TEXT PRIMARY KEY,
  created_at   INTEGER NOT NULL,
  event_id     TEXT REFERENCES events(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  seat         TEXT
);

CREATE TABLE IF NOT EXISTS sessions (
  id             TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  event_id       TEXT REFERENCES events(id) ON DELETE SET NULL,
  round_id       TEXT REFERENCES rounds(id) ON DELETE SET NULL,
  participant_id TEXT REFERENCES participants(id) ON DELETE SET NULL,
  mode           TEXT NOT NULL,
  label          TEXT NOT NULL,
  consent        TEXT NOT NULL,        -- JSON Consent
  status         TEXT NOT NULL DEFAULT 'live',
  started_at     INTEGER,
  ended_at       INTEGER,
  languages      TEXT NOT NULL DEFAULT '[]',   -- JSON string[]
  expect_speakers INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_sessions_event ON sessions(event_id);

CREATE TABLE IF NOT EXISTS transcript_segments (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  source      TEXT NOT NULL,
  t0          REAL NOT NULL,
  t1          REAL NOT NULL,
  text        TEXT NOT NULL,
  is_final    INTEGER NOT NULL,
  lang        TEXT,
  speaker_id  TEXT
);
CREATE INDEX IF NOT EXISTS idx_segments_session ON transcript_segments(session_id, t0);

CREATE TABLE IF NOT EXISTS speech_metrics (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at_ms       REAL NOT NULL,
  kind        TEXT NOT NULL,
  snapshot    TEXT NOT NULL          -- JSON snapshot blob
);
CREATE INDEX IF NOT EXISTS idx_metrics_session ON speech_metrics(session_id, at_ms);

CREATE TABLE IF NOT EXISTS audit_events (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  object_type TEXT NOT NULL,
  object_id   TEXT NOT NULL,
  session_id  TEXT,
  event_id    TEXT,
  prev        TEXT,
  next        TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_session ON audit_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_event ON audit_events(event_id, created_at);

-- ---- Phase 2: judging ----

CREATE TABLE IF NOT EXISTS rubrics (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  event_id    TEXT REFERENCES events(id) ON DELETE SET NULL,
  name        TEXT NOT NULL,
  event_type  TEXT NOT NULL,
  criteria    TEXT NOT NULL          -- JSON RubricCriterion[]
);

CREATE TABLE IF NOT EXISTS timeline_events (
  id          TEXT PRIMARY KEY,
  created_at  INTEGER NOT NULL,
  session_id  TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  at_ms       REAL NOT NULL,
  end_ms      REAL,
  type        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  confidence  TEXT NOT NULL,
  source      TEXT NOT NULL,
  description TEXT NOT NULL,
  linked_text TEXT
);
CREATE INDEX IF NOT EXISTS idx_timeline_session ON timeline_events(session_id, at_ms);

CREATE TABLE IF NOT EXISTS judge_evaluations (
  id               TEXT PRIMARY KEY,
  created_at       INTEGER NOT NULL,
  session_id       TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  rubric_id        TEXT NOT NULL,
  rubric_name      TEXT NOT NULL,
  judge_type       TEXT NOT NULL,        -- 'ai' | 'human'
  judge_id         TEXT,
  status           TEXT NOT NULL,        -- 'draft' | 'final'
  scale_max        REAL NOT NULL,
  overall_score    REAL NOT NULL,
  overall_confidence TEXT NOT NULL,
  criteria         TEXT NOT NULL,        -- JSON CriterionScore[]
  notes            TEXT
);
CREATE INDEX IF NOT EXISTS idx_eval_session ON judge_evaluations(session_id, created_at);

-- ---- Phase 3: integrity ----

CREATE TABLE IF NOT EXISTS integrity_cases (
  id                 TEXT PRIMARY KEY,
  created_at         INTEGER NOT NULL,
  session_id         TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id           TEXT,
  participant_id     TEXT,
  policy_snapshot    TEXT NOT NULL,        -- JSON EventPolicy
  risk_level         TEXT NOT NULL,        -- LOW | MODERATE | HIGH | CRITICAL
  confidence         TEXT NOT NULL,
  signals            TEXT NOT NULL,        -- JSON IntegritySignal[]
  source_matches     TEXT NOT NULL,        -- JSON SourceMatch[]
  participant_matches TEXT NOT NULL,       -- JSON ParticipantMatch[]
  style_analysis     TEXT,                 -- JSON StyleDeviation | null
  preparedness       TEXT,                 -- JSON PreparednessAnalysis
  session_integrity  TEXT,                 -- JSON SessionIntegrityReport
  recommendation     TEXT NOT NULL,
  not_proved_note    TEXT NOT NULL,
  search_coverage    TEXT NOT NULL,
  status             TEXT NOT NULL,        -- pending_review | dismissed | monitoring | investigating | confirmed
  review             TEXT                  -- JSON IntegrityReview | null
);
CREATE INDEX IF NOT EXISTS idx_integrity_session ON integrity_cases(session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_integrity_event ON integrity_cases(event_id, created_at);

CREATE TABLE IF NOT EXISTS style_baselines (
  id             TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  participant_id TEXT NOT NULL,
  sessions_used  INTEGER NOT NULL,
  metrics        TEXT NOT NULL,        -- JSON StyleMetrics
  spread         TEXT NOT NULL        -- JSON StyleMetrics
);
CREATE INDEX IF NOT EXISTS idx_style_participant ON style_baselines(participant_id, created_at);

CREATE TABLE IF NOT EXISTS session_artifacts (
  id              TEXT PRIMARY KEY,
  created_at      INTEGER NOT NULL,
  session_id      TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  transcript_hash TEXT NOT NULL,
  snapshot_hash   TEXT NOT NULL,
  timeline_hash   TEXT NOT NULL,
  segment_count   INTEGER NOT NULL,
  audio_ms_total  REAL NOT NULL,
  reconnects      INTEGER NOT NULL DEFAULT 0
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_session ON session_artifacts(session_id);

CREATE TABLE IF NOT EXISTS integrity_appeals (
  id                 TEXT PRIMARY KEY,
  created_at         INTEGER NOT NULL,
  case_id            TEXT NOT NULL REFERENCES integrity_cases(id) ON DELETE CASCADE,
  session_id         TEXT NOT NULL,
  submitted_by       TEXT NOT NULL,
  statement          TEXT NOT NULL,
  source_attribution TEXT,
  response           TEXT                 -- JSON AppealResponse | null
);
CREATE INDEX IF NOT EXISTS idx_appeals_case ON integrity_appeals(case_id, created_at);

-- ---- Phase 6: coaching ----

CREATE TABLE IF NOT EXISTS coach_plans (
  id             TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  session_id     TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  participant_id TEXT,
  evaluation_id  TEXT NOT NULL,
  persona        TEXT NOT NULL,
  overall_score  REAL NOT NULL,
  scale_max      REAL NOT NULL,
  focus_areas    TEXT NOT NULL,      -- JSON string[]
  weaknesses     TEXT NOT NULL,      -- JSON CoachWeakness[]
  summary        TEXT NOT NULL,
  keep_doing     TEXT NOT NULL       -- JSON string[]
);
CREATE INDEX IF NOT EXISTS idx_coachplan_session ON coach_plans(session_id, created_at);

CREATE TABLE IF NOT EXISTS drills (
  id                  TEXT PRIMARY KEY,
  created_at          INTEGER NOT NULL,
  plan_id             TEXT,
  session_id          TEXT NOT NULL,
  participant_id      TEXT,
  type                TEXT NOT NULL,
  difficulty          TEXT NOT NULL,
  from_weakness       TEXT NOT NULL,
  prompt              TEXT NOT NULL,
  time_limit_sec      INTEGER NOT NULL,
  status              TEXT NOT NULL,
  response_session_id TEXT,
  exchanges           TEXT NOT NULL DEFAULT '[]',  -- JSON DrillExchange[]
  grade               TEXT                         -- JSON DrillGrade | null
);
CREATE INDEX IF NOT EXISTS idx_drills_plan ON drills(plan_id, created_at);
CREATE INDEX IF NOT EXISTS idx_drills_session ON drills(session_id, created_at);

-- ---- Phase 7: competition OS ----

CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  created_at     INTEGER NOT NULL,
  name           TEXT NOT NULL,
  email          TEXT UNIQUE,
  role           TEXT NOT NULL,
  participant_id TEXT,
  password_hash  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS integrity_analytics (
  id            TEXT PRIMARY KEY,
  created_at    INTEGER NOT NULL,
  session_id    TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id      TEXT,
  source_match_count      INTEGER NOT NULL,
  cross_participant_max   REAL NOT NULL,
  distinctive_phrases_checked INTEGER NOT NULL,
  note          TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_intanalytics_session ON integrity_analytics(session_id);
