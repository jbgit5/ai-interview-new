-- ============================================================
-- MIGRATION 005: Question modes & source tracking
-- ============================================================

-- question_mode on jobs: how AI selects/generates questions
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS question_mode TEXT NOT NULL DEFAULT 'ai_only'
    CHECK (question_mode IN ('ai_only', 'custom_only', 'mixed'));

-- source on questions: who created them
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'custom'
    CHECK (source IN ('ai_generated', 'custom', 'resume'));

-- probe_count tracking per session+question (for probe limits)
CREATE TABLE IF NOT EXISTS question_probe_counts (
  session_id   UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  question_id  UUID NOT NULL REFERENCES questions(id) ON DELETE CASCADE,
  probe_count  INT NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, question_id)
);
