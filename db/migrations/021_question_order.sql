-- ============================================================
-- MIGRATION 021: question order per interview
-- HR chooses, when inviting, whether the candidate's own questions are asked before or after the
-- job's common questions. Default keeps the existing behaviour (own questions first).
-- The interview brain reads it with a to_jsonb fallback, so interviews keep working on a database
-- where this migration has not run yet. Additive, idempotent.
-- ============================================================
ALTER TABLE interview_sessions
  ADD COLUMN IF NOT EXISTS question_order TEXT NOT NULL DEFAULT 'own_first';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'interview_sessions_question_order_check') THEN
    ALTER TABLE interview_sessions
      ADD CONSTRAINT interview_sessions_question_order_check CHECK (question_order IN ('own_first', 'common_first'));
  END IF;
END $$;
