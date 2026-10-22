-- Migration 007: Company intro + off-topic boundary tracking
--
-- jobs.company_intro
--   Short text Maya reads aloud as part of the opening greeting.
--   Recruiter configures this in the job form; server-side trimmed to 300 chars.
--   Approximate TTS duration: 250 chars ≈ 15 seconds at normal speaking pace.
--
-- interview_sessions.offtopic_redirect_issued
--   Ensures Maya only redirects a candidate once per session when they give
--   a clearly off-topic answer. After the first redirect the interview
--   continues normally without further interruptions.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS company_intro TEXT;

ALTER TABLE interview_sessions
  ADD COLUMN IF NOT EXISTS offtopic_redirect_issued BOOLEAN NOT NULL DEFAULT FALSE;
