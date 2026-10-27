-- ============================================================
-- MIGRATION 020: per-candidate interview questions (draft)
-- A screened candidate's own interview questions — CV-based suggestions HR kept/edited plus
-- HR's own questions — prepared before the invite. At invite time the CONFIRMED list is copied
-- into questions (session_id = the new interview) and asked before the job's common questions.
-- Shape: [{ "text": "...", "source": "cv" | "hr" }]. NULL = not prepared yet (UI starts from
-- the screening's suggested questions). Additive, idempotent.
-- ============================================================
ALTER TABLE cv_documents
  ADD COLUMN IF NOT EXISTS interview_questions JSONB;
