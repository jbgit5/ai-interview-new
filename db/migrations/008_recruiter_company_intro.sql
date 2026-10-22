-- Migration 008: Recruiter-level company intro template
--
-- recruiters.company_intro
--   Single company-wide intro (spoken by Maya in opening, ~10–15 sec).
--   This portal is single-employer, so we store it once per recruiter account.

ALTER TABLE recruiters
  ADD COLUMN IF NOT EXISTS company_intro TEXT;

