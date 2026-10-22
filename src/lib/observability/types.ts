/**
 * Shapes returned by read-only observability queries APIs.
 * Maps to `session_telemetry_*`, `turn_metrics`, and `telemetry_daily_rollup`.
 */

export type OverviewKpis = {
  totalInterviews: number;
  activeSessions: number;
  /** Avg p95 transcript latency (ms) across sessions with telemetry */
  avgSttLatencyMs: number | null;
  /** Avg p95 brain LLM latency (ms) from summaries */
  avgAiLatencyMs: number | null;
  /** Interruptions per session average (from summary.interruption_count) */
  avgInterruptionsPerSession: number | null;
  /** Sum of probes / sessions with probes */
  avgProbesPerSession: number | null;
  /** % of completed sessions where livekit disconnect events > 0 */
  websocketIssueRate: number | null;
  /** Early exits / completed sessions */
  sessionDropPct: number | null;
  /** Trend series last N days */
  dailyBrainP95: { day: string; value: number }[];
  dailySessions: { day: string; count: number }[];
};

export type VendorStats = {
  vendor: "stt" | "openai" | "livekit";
  label: string;
  avgLatencyMs: number | null;
  p95LatencyMs: number | null;
  reconnectsOrRetries: number;
  failures: number;
  samples: number;
};

export type SessionListItem = {
  session_id: string;
  job_id: string;
  job_title: string;
  candidate_name: string | null;
  status: string;
  started_at: Date | null;
  completed_at: Date | null;
  brain_p95: number | null;
};

export type TelemetryEventRow = {
  id: number;
  occurred_at: string;
  event_name: string;
  source: string;
  trace_id: string | null;
  turn_index: number | null;
  attrs: Record<string, unknown>;
};

/** Recharts row: sparse STT / LLM / TTS samples on a shared index axis */
export type LatencyChartRow = {
  label: string;
  stt: number | null;
  llm: number | null;
  tts: number | null;
};
