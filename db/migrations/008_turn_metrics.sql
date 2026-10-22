-- Migration 008: Turn-level latency metrics + interview cost tracking
--
-- turn_metrics
--   One row per non-opening interview turn.
--   Captures per-stage timing breakdown and GPT token usage so the report
--   page can show p50/p95 latency and exact cost for every completed interview.
--
-- analysis_results additions (cost columns)
--   Aggregated from turn_metrics at session-end time so the report page
--   can display a single "Total cost" figure without summing at query time.

CREATE TABLE IF NOT EXISTS turn_metrics (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               UUID        NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  turn_index               INT         NOT NULL,
  action                   TEXT        NOT NULL CHECK (action IN ('probe', 'next', 'close', 'opening', 'redirect')),
  db_session_ms            INT         NOT NULL DEFAULT 0,
  db_parallel_ms           INT         NOT NULL DEFAULT 0,
  llm_ms                   INT         NOT NULL DEFAULT 0,
  write_ms                 INT         NOT NULL DEFAULT 0,
  total_ms                 INT         NOT NULL DEFAULT 0,
  brain_prompt_tokens      INT         NOT NULL DEFAULT 0,
  brain_completion_tokens  INT         NOT NULL DEFAULT 0,
  scoring_total_tokens     INT         NOT NULL DEFAULT 0,
  offtopic_redirect        BOOLEAN     NOT NULL DEFAULT FALSE,
  recorded_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_turn_metrics_session ON turn_metrics(session_id);
CREATE INDEX IF NOT EXISTS idx_turn_metrics_session_turn ON turn_metrics(session_id, turn_index);

-- Cost rollup columns on analysis_results.
-- Populated by the /end route after summing all turn_metrics rows for the session.
-- GPT pricing at time of migration (update if OpenAI prices change):
--   GPT-4o input:         $2.50 / 1M tokens
--   GPT-4o output:        $10.00 / 1M tokens
--   GPT-4o-mini (mixed):  ~$0.15 / 1M tokens (blended scoring input/output)
--   TTS-1:                $15.00 / 1M characters
ALTER TABLE analysis_results
  ADD COLUMN IF NOT EXISTS total_brain_prompt_tokens     INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_brain_completion_tokens INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_scoring_tokens          INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS total_tts_chars               INT     NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS estimated_cost_usd            NUMERIC(8,4) NOT NULL DEFAULT 0;
