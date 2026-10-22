-- ============================================================
-- MIGRATION 001: Core Tables
-- Apply after 000_better_auth.sql (psql, Docker setup, or SQL client)
-- ============================================================

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- TABLE: recruiters
-- One row per HR user. Created via better-auth databaseHooks on sign-up
-- ============================================================
CREATE TABLE recruiters (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  better_auth_user_id TEXT UNIQUE NOT NULL,
  email           TEXT NOT NULL,
  name            TEXT,
  company_name    TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recruiters_auth_user_id ON recruiters(better_auth_user_id);

-- ============================================================
-- TABLE: jobs
-- A job posting created by a recruiter
-- ============================================================
CREATE TABLE jobs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recruiter_id    UUID NOT NULL REFERENCES recruiters(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  department      TEXT,
  description     TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'active', 'closed')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_jobs_recruiter_id ON jobs(recruiter_id);
CREATE INDEX idx_jobs_status ON jobs(status);

-- ============================================================
-- TABLE: questions
-- Interview questions for a job (manual or AI-generated from JD)
-- ============================================================
CREATE TABLE questions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  text            TEXT NOT NULL,
  category        TEXT NOT NULL
                    CHECK (category IN ('technical', 'behavioral', 'situational', 'culture')),
  difficulty      INT NOT NULL DEFAULT 1 CHECK (difficulty BETWEEN 1 AND 3),
  expected_hint   TEXT,
  order_index     INT NOT NULL DEFAULT 0,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_questions_job_id ON questions(job_id);
CREATE INDEX idx_questions_job_order ON questions(job_id, order_index);

-- ============================================================
-- TABLE: scoring_rubrics
-- HR-defined competencies and their weights for a job
-- ============================================================
CREATE TABLE scoring_rubrics (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  competency      TEXT NOT NULL,
  weight          INT NOT NULL CHECK (weight > 0 AND weight <= 100),
  description     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_rubrics_job_id ON scoring_rubrics(job_id);

-- ============================================================
-- TABLE: interview_sessions
-- One row per candidate invite sent
-- ============================================================
CREATE TABLE interview_sessions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          UUID NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  token           UUID UNIQUE NOT NULL DEFAULT gen_random_uuid(),
  candidate_name  TEXT,
  candidate_email TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'completed', 'expired', 'shortlisted', 'rejected')),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '7 days'),
  video_url       TEXT,
  resume_state    JSONB,
  livekit_room    TEXT,
  integrity_score INT DEFAULT 100,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_sessions_job_id ON interview_sessions(job_id);
CREATE INDEX idx_sessions_token ON interview_sessions(token);
CREATE INDEX idx_sessions_status ON interview_sessions(status);
CREATE INDEX idx_sessions_email ON interview_sessions(candidate_email);

-- ============================================================
-- TABLE: transcript_turns
-- Every spoken turn in the interview
-- ============================================================
CREATE TABLE transcript_turns (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  turn_index      INT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('interviewer', 'candidate')),
  content         TEXT NOT NULL,
  question_id     UUID REFERENCES questions(id),
  timestamp_ms    BIGINT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  
  UNIQUE(session_id, turn_index, role)
);

CREATE INDEX idx_turns_session_id ON transcript_turns(session_id);
CREATE INDEX idx_turns_session_turn ON transcript_turns(session_id, turn_index);

-- ============================================================
-- TABLE: question_scores
-- Per-answer AI scoring
-- ============================================================
CREATE TABLE question_scores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  question_id     UUID REFERENCES questions(id),
  turn_index      INT NOT NULL,
  score           INT NOT NULL CHECK (score BETWEEN 1 AND 10),
  reasoning       TEXT NOT NULL,
  competencies    JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_scores_session_id ON question_scores(session_id);

-- ============================================================
-- TABLE: analysis_results
-- Final aggregated analysis after interview completes
-- ============================================================
CREATE TABLE analysis_results (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id            UUID UNIQUE NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  overall_score         NUMERIC(5,2),
  recommendation        TEXT CHECK (
                          recommendation IN ('strong_yes', 'yes', 'no', 'strong_no')
                        ),
  ai_summary            TEXT,
  competency_scores     JSONB,
  strengths             TEXT[],
  concerns              TEXT[],
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- TABLE: proctoring_events
-- Every integrity violation event during the interview
-- ============================================================
CREATE TABLE proctoring_events (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id      UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL CHECK (
                    event_type IN (
                      'tab_switch',
                      'window_blur',
                      'multi_face',
                      'no_face',
                      'gaze_away',
                      'paste_detected'
                    )
                  ),
  timestamp_ms    BIGINT NOT NULL,
  duration_ms     BIGINT,
  severity        TEXT NOT NULL DEFAULT 'low'
                    CHECK (severity IN ('low', 'medium', 'high')),
  metadata        JSONB,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_proctor_session_id ON proctoring_events(session_id);
CREATE INDEX idx_proctor_event_type ON proctoring_events(event_type);
