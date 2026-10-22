-- ============================================================
-- MIGRATION 002: Row Level Security (RLS) Policies
-- Run this after 001_core_tables.sql
-- ============================================================

-- Enable RLS on all tables
ALTER TABLE recruiters ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE questions ENABLE ROW LEVEL SECURITY;
ALTER TABLE scoring_rubrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE interview_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE transcript_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE question_scores ENABLE ROW LEVEL SECURITY;
ALTER TABLE analysis_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE proctoring_events ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- NOTE: Server-side API routes use a direct Postgres pool (superuser-style
-- connection); RLS is optional for defense in depth if clients connect as
-- a limited role. Local dev often skips this migration.
-- ============================================================

-- recruiters: own row only
CREATE POLICY "recruiters_own_row"
  ON recruiters FOR ALL
  USING (better_auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub');

-- jobs: recruiter can only see their own jobs
CREATE POLICY "jobs_own"
  ON jobs FOR ALL
  USING (
    recruiter_id = (
      SELECT id FROM recruiters
      WHERE better_auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- questions: recruiter can only see questions for their own jobs
CREATE POLICY "questions_own"
  ON questions FOR ALL
  USING (
    job_id IN (
      SELECT id FROM jobs WHERE recruiter_id = (
        SELECT id FROM recruiters
        WHERE better_auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
      )
    )
  );

-- scoring_rubrics: same as questions
CREATE POLICY "rubrics_own"
  ON scoring_rubrics FOR ALL
  USING (
    job_id IN (
      SELECT id FROM jobs WHERE recruiter_id = (
        SELECT id FROM recruiters
        WHERE better_auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
      )
    )
  );

-- interview_sessions: recruiter can read sessions for their jobs
CREATE POLICY "sessions_recruiter_access"
  ON interview_sessions FOR ALL
  USING (
    job_id IN (
      SELECT id FROM jobs WHERE recruiter_id = (
        SELECT id FROM recruiters
        WHERE better_auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
      )
    )
  );

-- transcript_turns: recruiter only
CREATE POLICY "turns_recruiter_access"
  ON transcript_turns FOR ALL
  USING (
    session_id IN (
      SELECT s.id FROM interview_sessions s
      JOIN jobs j ON j.id = s.job_id
      JOIN recruiters r ON r.id = j.recruiter_id
      WHERE r.better_auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- question_scores: recruiter only
CREATE POLICY "scores_recruiter_access"
  ON question_scores FOR ALL
  USING (
    session_id IN (
      SELECT s.id FROM interview_sessions s
      JOIN jobs j ON j.id = s.job_id
      JOIN recruiters r ON r.id = j.recruiter_id
      WHERE r.better_auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- analysis_results: recruiter only
CREATE POLICY "analysis_recruiter_access"
  ON analysis_results FOR ALL
  USING (
    session_id IN (
      SELECT s.id FROM interview_sessions s
      JOIN jobs j ON j.id = s.job_id
      JOIN recruiters r ON r.id = j.recruiter_id
      WHERE r.better_auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );

-- proctoring_events: recruiter only
CREATE POLICY "proctor_recruiter_access"
  ON proctoring_events FOR ALL
  USING (
    session_id IN (
      SELECT s.id FROM interview_sessions s
      JOIN jobs j ON j.id = s.job_id
      JOIN recruiters r ON r.id = j.recruiter_id
      WHERE r.better_auth_user_id = current_setting('request.jwt.claims', true)::json->>'sub'
    )
  );
