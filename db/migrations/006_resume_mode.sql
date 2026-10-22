-- ============================================================
-- MIGRATION 006: Resume mode + session-scoped questions
-- ============================================================

-- Add 'resume' to question_mode options
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_question_mode_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_question_mode_check
  CHECK (question_mode IN ('ai_only', 'custom_only', 'mixed', 'resume'));

-- session_id on questions: for per-candidate resume questions
ALTER TABLE questions
  ADD COLUMN IF NOT EXISTS session_id UUID REFERENCES interview_sessions(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_questions_session_id ON questions(session_id);

-- resume_text on interview_sessions: store extracted CV text
ALTER TABLE interview_sessions
  ADD COLUMN IF NOT EXISTS resume_text TEXT;
