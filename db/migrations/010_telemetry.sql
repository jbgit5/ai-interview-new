-- Telemetry & observability (see docs/OBSERVABILITY.md)
-- session_id / job_id are UUIDs (matches 001_core_tables + turn_metrics).

CREATE TABLE IF NOT EXISTS session_telemetry_events (
  id              BIGSERIAL PRIMARY KEY,
  session_id      UUID NOT NULL REFERENCES interview_sessions(id) ON DELETE CASCADE,
  occurred_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_name      TEXT NOT NULL,
  event_version   SMALLINT NOT NULL DEFAULT 1,
  source          TEXT NOT NULL CHECK (source IN ('client', 'server')),
  trace_id        UUID,
  turn_index      INT,
  attrs           JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_ste_session_time
  ON session_telemetry_events (session_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ste_name_time
  ON session_telemetry_events (event_name, occurred_at DESC);

CREATE TABLE IF NOT EXISTS session_telemetry_summary (
  session_id                   UUID PRIMARY KEY REFERENCES interview_sessions(id) ON DELETE CASCADE,
  computed_at                  TIMESTAMPTZ NOT NULL,
  transcript_latency_p95_ms    INT,
  brain_latency_p95_ms         INT,
  tts_first_byte_p95_ms        INT,
  eot_accuracy_rate            NUMERIC(5,4),
  probe_count                  INT,
  interruption_count           INT,
  total_pause_ms               BIGINT,
  stt_failure_count            INT,
  tts_failure_count            INT,
  livekit_disconnect_count     INT,
  fallback_event_count         INT,
  attrs                        JSONB DEFAULT '{}'::jsonb
);

-- job_id NULL = org-wide aggregate for that day (single row per day+metric via unique index).
CREATE TABLE IF NOT EXISTS telemetry_daily_rollup (
  id             BIGSERIAL PRIMARY KEY,
  day            DATE NOT NULL,
  job_id         UUID REFERENCES jobs(id) ON DELETE CASCADE,
  metric_key     TEXT NOT NULL,
  metric_value   DOUBLE PRECISION NOT NULL,
  sample_count   BIGINT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tdr_day_job_metric
  ON telemetry_daily_rollup (day, metric_key, COALESCE(job_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE INDEX IF NOT EXISTS idx_tdr_day ON telemetry_daily_rollup (day DESC);

CREATE TABLE IF NOT EXISTS telemetry_release_markers (
  id           SERIAL PRIMARY KEY,
  deployed_at  TIMESTAMPTZ NOT NULL,
  version      TEXT NOT NULL,
  git_sha      TEXT,
  notes        TEXT
);

-- Aggregated session overview for recruiter dashboard (scoped in query by recruiter_id).
CREATE OR REPLACE VIEW v_telemetry_session_overview AS
SELECT
  s.id                    AS session_id,
  s.job_id,
  s.candidate_name,
  s.completed_at,
  s.status,
  sts.brain_latency_p95_ms,
  sts.transcript_latency_p95_ms,
  sts.probe_count,
  sts.stt_failure_count,
  sts.tts_failure_count,
  sts.livekit_disconnect_count,
  sts.fallback_event_count,
  sts.computed_at         AS telemetry_computed_at
FROM interview_sessions s
LEFT JOIN session_telemetry_summary sts ON sts.session_id = s.id;
