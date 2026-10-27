-- ============================================================
-- MIGRATION 016: per-recruiter debug mode
-- When on, interview rooms for this recruiter's jobs show the developer panels (debug logs,
-- engine info, transcript, integrity score). Off by default: candidates see a clean,
-- Meet-style interview room. Toggled at Dashboard → Settings.
-- ============================================================
ALTER TABLE recruiters
  ADD COLUMN IF NOT EXISTS debug_mode BOOLEAN NOT NULL DEFAULT FALSE;
