-- ============================================================
-- MIGRATION 014: per-job GPT-Live voice toggle (experiment)
-- Recruiters opt a job into the GPT-Live voice engine from the job edit page.
-- Default FALSE: every existing and new job keeps the standard voice engine.
-- The toggle only has an effect when the server env master switch is also on
-- (LIVE_VOICE_ENABLED + OPENAI_LIVE_API_KEY) — see src/lib/live/guardrails.ts.
-- ============================================================
ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS live_voice_enabled BOOLEAN NOT NULL DEFAULT FALSE;
