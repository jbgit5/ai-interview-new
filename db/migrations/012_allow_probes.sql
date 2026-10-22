-- ============================================================
-- MIGRATION 012: Per-job toggle for follow-up probes
-- ============================================================
-- When FALSE, Maya must move to the next bank question after each
-- candidate answer (no follow-ups, no off-topic redirects). Default
-- is TRUE to preserve existing behavior for already-created jobs.

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS allow_probes BOOLEAN NOT NULL DEFAULT TRUE;
