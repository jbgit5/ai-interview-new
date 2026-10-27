-- ============================================================
-- MIGRATION 015: realistic-avatar (Simli) session ledger (experiment)
-- Every paid avatar session is recorded BEFORE its token is minted, so spend
-- guardrails (daily budget, concurrency, per-interview creates) are enforced
-- server-side. Mirrors live_voice_sessions (migration 013).
-- ============================================================
CREATE TABLE IF NOT EXISTS avatar_sessions (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  interview_session_id  UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  provider              TEXT NOT NULL DEFAULT 'simli',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Hard duration cap granted to this session (seconds). Also enforced by the provider
  -- (maxSessionLength in the token). Unclosed sessions are budgeted at this full amount.
  max_seconds           INT NOT NULL,
  closed_at             TIMESTAMPTZ,
  usage_seconds         INT,
  close_reason          TEXT
);

CREATE INDEX IF NOT EXISTS idx_avatar_sessions_created
  ON avatar_sessions (created_at);
CREATE INDEX IF NOT EXISTS idx_avatar_sessions_interview
  ON avatar_sessions (interview_session_id);
