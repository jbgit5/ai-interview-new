-- ============================================================
-- MIGRATION 013: GPT-Live voice session ledger (experiment)
-- Every paid GPT-Live session is recorded here BEFORE it is created, so
-- spend guardrails (daily budget, concurrency, per-interview creates) are
-- enforced server-side and cannot be bypassed from the browser.
-- ============================================================
CREATE TABLE IF NOT EXISTS live_voice_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_session_id  UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Hard duration cap granted to this session (seconds). Unclosed sessions are
  -- budgeted at this full amount until a close report arrives.
  max_seconds           INT NOT NULL,
  closed_at             TIMESTAMPTZ,
  -- Provider-reported billable seconds (clamped server-side on close).
  usage_seconds         INT,
  close_reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_live_voice_sessions_created
  ON live_voice_sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_live_voice_sessions_interview
  ON live_voice_sessions (interview_session_id);
