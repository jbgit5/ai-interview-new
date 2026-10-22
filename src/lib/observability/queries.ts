/**
 * Read-only observability aggregations for recruiter dashboards.
 * SELECT-only — does not alter telemetry ingest or schema.
 */
import type { Pool } from "pg";
import type {
  OverviewKpis,
  SessionListItem,
  TelemetryEventRow,
  VendorStats,
} from "./types";

const DAY_FMT = (d: Date) => d.toISOString().slice(0, 10);

export async function fetchOverviewKpis(
  pool: Pool,
  recruiterId: string,
  trendDays = 14
): Promise<OverviewKpis> {
  const summary = await pool.query<{
    total: string;
    active: string;
    avg_stt: string | null;
    avg_ai: string | null;
    avg_intr: string | null;
    sum_probe: string | null;
    cnt_with_summary: string | null;
    lk_sessions: string | null;
    lk_issue: string | null;
    completed: string;
    early: string;
  }>(
    `
    WITH scoped AS (
      SELECT s.id, s.status
      FROM interview_sessions s
      JOIN jobs j ON j.id = s.job_id
      WHERE j.recruiter_id = $1::uuid
    ),
    sts AS (
      SELECT sts.*
      FROM session_telemetry_summary sts
      JOIN scoped sc ON sc.id = sts.session_id
    )
    SELECT
      (SELECT COUNT(*)::text FROM scoped) AS total,
      (SELECT COUNT(*)::text FROM scoped WHERE status = 'in_progress') AS active,
      (SELECT AVG(sts.transcript_latency_p95_ms)::text FROM sts WHERE sts.transcript_latency_p95_ms IS NOT NULL) AS avg_stt,
      (SELECT AVG(sts.brain_latency_p95_ms)::text FROM sts WHERE sts.brain_latency_p95_ms IS NOT NULL) AS avg_ai,
      (SELECT AVG(sts.interruption_count)::text FROM sts WHERE sts.interruption_count IS NOT NULL) AS avg_intr,
      (SELECT SUM(sts.probe_count)::text FROM sts) AS sum_probe,
      (SELECT COUNT(*)::text FROM sts) AS cnt_with_summary,
      (SELECT COUNT(*)::text FROM sts WHERE sts.livekit_disconnect_count > 0) AS lk_issue,
      (SELECT COUNT(*)::text FROM sts) AS lk_sessions,
      (SELECT COUNT(*)::text FROM scoped WHERE status IN ('completed','shortlisted','rejected')) AS completed,
      (SELECT COUNT(*)::text
         FROM interview_sessions x
         JOIN jobs j ON j.id = x.job_id
        WHERE j.recruiter_id = $1::uuid
          AND x.status IN ('completed','shortlisted','rejected')
          AND x.exit_type = 'early_exit') AS early
    `,
    [recruiterId]
  );

  const row = summary.rows[0];
  const totalInterviews = Number(row?.total) || 0;
  const completed = Number(row?.completed) || 0;
  const early = Number(row?.early) || 0;
  const lkSessions = Number(row?.lk_sessions) || 0;
  const lkIssue = Number(row?.lk_issue) || 0;
  const sumProbe = Number(row?.sum_probe) || 0;
  const cntSummary = Number(row?.cnt_with_summary) || 0;

  const dailyBrain = await pool.query<{ day: Date; v: string }>(
    `
    SELECT d.day, d.metric_value::text AS v
      FROM telemetry_daily_rollup d
      JOIN jobs j ON j.id = d.job_id AND j.recruiter_id = $1::uuid
     WHERE d.metric_key = 'brain_latency_p95_avg'
       AND d.day >= (CURRENT_DATE - $2::integer)
     ORDER BY d.day ASC
    `,
    [recruiterId, trendDays]
  );

  const dailyCounts = await pool.query<{ day: Date; c: string }>(
    `
    SELECT d.day, d.metric_value::text AS c
      FROM telemetry_daily_rollup d
      JOIN jobs j ON j.id = d.job_id AND j.recruiter_id = $1::uuid
     WHERE d.metric_key = 'sessions_with_telemetry'
       AND d.day >= (CURRENT_DATE - $2::integer)
     ORDER BY d.day ASC
    `,
    [recruiterId, trendDays]
  );

  return {
    totalInterviews,
    activeSessions: Number(row?.active) || 0,
    avgSttLatencyMs: row?.avg_stt != null ? Math.round(Number(row.avg_stt)) : null,
    avgAiLatencyMs: row?.avg_ai != null ? Math.round(Number(row.avg_ai)) : null,
    avgInterruptionsPerSession:
      row?.avg_intr != null ? Math.round(Number(row.avg_intr) * 100) / 100 : null,
    avgProbesPerSession:
      cntSummary > 0 ? Math.round((sumProbe / cntSummary) * 100) / 100 : null,
    websocketIssueRate: lkSessions > 0 ? Math.round((lkIssue / lkSessions) * 1000) / 10 : null,
    sessionDropPct:
      completed > 0 ? Math.round((early / completed) * 1000) / 10 : null,
    dailyBrainP95: dailyBrain.rows.map((r) => ({
      day: DAY_FMT(new Date(r.day)),
      value: Number(r.v) || 0,
    })),
    dailySessions: dailyCounts.rows.map((r) => ({
      day: DAY_FMT(new Date(r.day)),
      count: Math.round(Number(r.c)) || 0,
    })),
  };
}

export async function fetchVendorStats(
  pool: Pool,
  recruiterId: string,
  sinceDays = 30
): Promise<VendorStats[]> {
  const since = new Date();
  since.setDate(since.getDate() - sinceDays);

  const stt = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE event_name IN ('stt.error','stt.fallback','stt.deepgram.error')) AS fails,
      COUNT(*) FILTER (WHERE event_name LIKE 'stt.%' OR event_name = 'stt.error') AS n
    FROM session_telemetry_events e
    JOIN interview_sessions s ON s.id = e.session_id
    JOIN jobs j ON j.id = s.job_id
    WHERE j.recruiter_id = $1::uuid AND e.occurred_at >= $2::timestamptz
    `,
    [recruiterId, since]
  );

  const openai = await pool.query(
    `
    SELECT
      (SELECT AVG((attrs->>'llm_ms')::numeric)
         FROM session_telemetry_events e
         JOIN interview_sessions s ON s.id = e.session_id
         JOIN jobs j ON j.id = s.job_id
        WHERE j.recruiter_id = $1::uuid AND e.occurred_at >= $2::timestamptz
          AND e.event_name = 'ai.brain.completed'
          AND (e.attrs->>'llm_ms') IS NOT NULL) AS avg_ai,
      (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY (attrs->>'llm_ms')::numeric)
         FROM session_telemetry_events e
         JOIN interview_sessions s ON s.id = e.session_id
         JOIN jobs j ON j.id = s.job_id
        WHERE j.recruiter_id = $1::uuid AND e.occurred_at >= $2::timestamptz
          AND e.event_name = 'ai.brain.completed'
          AND (e.attrs->>'llm_ms') IS NOT NULL) AS p95_ai,
      (SELECT AVG((attrs->>'tts_fetch_ms')::numeric)
         FROM session_telemetry_events e
         JOIN interview_sessions s ON s.id = e.session_id
         JOIN jobs j ON j.id = s.job_id
        WHERE j.recruiter_id = $1::uuid AND e.occurred_at >= $2::timestamptz
          AND e.event_name = 'tts.openai.completed') AS avg_tts,
      (SELECT percentile_cont(0.95) WITHIN GROUP (ORDER BY (attrs->>'tts_fetch_ms')::numeric)
         FROM session_telemetry_events e
         JOIN interview_sessions s ON s.id = e.session_id
         JOIN jobs j ON j.id = s.job_id
        WHERE j.recruiter_id = $1::uuid AND e.occurred_at >= $2::timestamptz
          AND e.event_name = 'tts.openai.completed') AS p95_tts,
      (SELECT COUNT(*) FROM session_telemetry_events e
         JOIN interview_sessions s ON s.id = e.session_id
         JOIN jobs j ON j.id = s.job_id
        WHERE j.recruiter_id = $1::uuid AND e.occurred_at >= $2::timestamptz
          AND e.event_name IN ('ai.brain.completed','tts.openai.completed')) AS n,
      (SELECT COUNT(*) FROM session_telemetry_events e
         JOIN interview_sessions s ON s.id = e.session_id
         JOIN jobs j ON j.id = s.job_id
        WHERE j.recruiter_id = $1::uuid AND e.occurred_at >= $2::timestamptz
          AND e.event_name = 'tts.error') AS tts_fail
    `,
    [recruiterId, since]
  );

  const lk = await pool.query(
    `
    SELECT
      COUNT(*) FILTER (WHERE event_name = 'livekit.room.disconnected') AS disconnects,
      COUNT(*) FILTER (WHERE event_name = 'livekit.connection.reconnecting') AS reconnects,
      COUNT(*) FILTER (WHERE event_name LIKE 'livekit.%') AS n
    FROM session_telemetry_events e
    JOIN interview_sessions s ON s.id = e.session_id
    JOIN jobs j ON j.id = s.job_id
    WHERE j.recruiter_id = $1::uuid AND e.occurred_at >= $2::timestamptz
    `,
    [recruiterId, since]
  );

  const o = openai.rows[0];
  const l = lk.rows[0];
  const brainAvg = o?.avg_ai != null ? Number(o.avg_ai) : null;
  const brainP95 = o?.p95_ai != null ? Number(o.p95_ai) : null;
  const ttsAvg = o?.avg_tts != null ? Number(o.avg_tts) : null;
  const ttsP95 = o?.p95_tts != null ? Number(o.p95_tts) : null;

  const openaiAvg =
    brainAvg != null && ttsAvg != null
      ? Math.round((brainAvg + ttsAvg) / 2)
      : brainAvg != null
        ? Math.round(brainAvg)
        : ttsAvg != null
          ? Math.round(ttsAvg)
          : null;
  const openaiP95 =
    brainP95 != null && ttsP95 != null
      ? Math.round(Math.max(brainP95, ttsP95))
      : brainP95 != null
        ? Math.round(brainP95)
        : ttsP95 != null
          ? Math.round(ttsP95)
          : null;

  return [
    {
      vendor: "stt",
      label: "Speech-to-text",
      avgLatencyMs: null,
      p95LatencyMs: null,
      reconnectsOrRetries: 0,
      failures: Number(stt.rows[0]?.fails) || 0,
      samples: Number(stt.rows[0]?.n) || 0,
    },
    {
      vendor: "openai",
      label: "OpenAI (GPT + TTS)",
      avgLatencyMs: openaiAvg,
      p95LatencyMs: openaiP95,
      reconnectsOrRetries: 0,
      failures: Number(o?.tts_fail) || 0,
      samples: Number(o?.n) || 0,
    },
    {
      vendor: "livekit",
      label: "LiveKit",
      avgLatencyMs: null,
      p95LatencyMs: null,
      reconnectsOrRetries: Number(l?.reconnects) || 0,
      failures: Number(l?.disconnects) || 0,
      samples: Number(l?.n) || 0,
    },
  ];
}

export async function fetchSessionsForRecruiter(
  pool: Pool,
  recruiterId: string,
  limit = 50
): Promise<SessionListItem[]> {
  const r = await pool.query(
    `
    SELECT
      s.id AS session_id,
      s.job_id,
      j.title AS job_title,
      s.candidate_name,
      s.status,
      s.started_at,
      s.completed_at,
      sts.brain_latency_p95_ms AS brain_p95
    FROM interview_sessions s
    JOIN jobs j ON j.id = s.job_id
    LEFT JOIN session_telemetry_summary sts ON sts.session_id = s.id
    WHERE j.recruiter_id = $1::uuid
    ORDER BY COALESCE(s.completed_at, s.started_at, s.created_at) DESC NULLS LAST
    LIMIT $2
    `,
    [recruiterId, limit]
  );
  return r.rows.map((row) => ({
    session_id: row.session_id,
    job_id: row.job_id,
    job_title: row.job_title,
    candidate_name: row.candidate_name,
    status: row.status,
    started_at: row.started_at,
    completed_at: row.completed_at,
    brain_p95: row.brain_p95 != null ? Number(row.brain_p95) : null,
  }));
}

export async function fetchSessionEvents(
  pool: Pool,
  recruiterId: string,
  sessionId: string,
  limit = 200
): Promise<TelemetryEventRow[] | null> {
  const own = await pool.query(
    `SELECT 1 FROM interview_sessions s
       JOIN jobs j ON j.id = s.job_id
      WHERE s.id = $1::uuid AND j.recruiter_id = $2::uuid`,
    [sessionId, recruiterId]
  );
  if (own.rows.length === 0) return null;

  const r = await pool.query(
    `
    SELECT id, occurred_at, event_name, source, trace_id, turn_index, attrs
      FROM session_telemetry_events
     WHERE session_id = $1::uuid
     ORDER BY occurred_at DESC
     LIMIT $2
    `,
    [sessionId, limit]
  );

  return r.rows.map((row) => ({
    id: Number(row.id),
    occurred_at: new Date(row.occurred_at).toISOString(),
    event_name: row.event_name,
    source: row.source,
    trace_id: row.trace_id,
    turn_index: row.turn_index,
    attrs:
      typeof row.attrs === "object" && row.attrs !== null
        ? (row.attrs as Record<string, unknown>)
        : {},
  }));
}

export async function fetchTrends(
  pool: Pool,
  recruiterId: string,
  days = 30
): Promise<{
  brainP95: { day: string; value: number }[];
  interruptions: { day: string; value: number }[];
  probes: { day: string; value: number }[];
  health: { day: string; score: number }[];
}> {
  const brain = await pool.query(
    `
    SELECT d.day, d.metric_value::float8 AS v
      FROM telemetry_daily_rollup d
      JOIN jobs j ON j.id = d.job_id
     WHERE j.recruiter_id = $1::uuid
       AND d.metric_key = 'brain_latency_p95_avg'
       AND d.day >= (CURRENT_DATE - $2::integer)
     ORDER BY d.day ASC
    `,
    [recruiterId, days]
  );

  const intr = await pool.query(
    `
    SELECT DATE(s.completed_at) AS day,
           SUM(sts.interruption_count)::float8 AS v
      FROM interview_sessions s
      JOIN jobs j ON j.id = s.job_id
      JOIN session_telemetry_summary sts ON sts.session_id = s.id
     WHERE j.recruiter_id = $1::uuid
       AND s.completed_at >= (CURRENT_DATE - $2::integer)
     GROUP BY DATE(s.completed_at)
     ORDER BY day ASC
    `,
    [recruiterId, days]
  );

  const probes = await pool.query(
    `
    SELECT DATE(s.completed_at) AS day,
           AVG(sts.probe_count)::float8 AS v
      FROM interview_sessions s
      JOIN jobs j ON j.id = s.job_id
      JOIN session_telemetry_summary sts ON sts.session_id = s.id
     WHERE j.recruiter_id = $1::uuid
       AND s.completed_at >= (CURRENT_DATE - $2::integer)
     GROUP BY DATE(s.completed_at)
     ORDER BY day ASC
    `,
    [recruiterId, days]
  );

  const brainP95 = brain.rows.map((b) => ({
    day: DAY_FMT(new Date(b.day)),
    value: Number(b.v) || 0,
  }));

  const health = brain.rows.map((b) => {
    const v = Number(b.v) || 0;
    const score = Math.max(0, Math.min(100, 100 - v / 50));
    return {
      day: DAY_FMT(new Date(b.day)),
      score: Math.round(score * 10) / 10,
    };
  });

  return {
    brainP95,
    interruptions: intr.rows.map((x) => ({
      day: DAY_FMT(new Date(x.day)),
      value: Number(x.v) || 0,
    })),
    probes: probes.rows.map((x) => ({
      day: DAY_FMT(new Date(x.day)),
      value: Math.round((Number(x.v) || 0) * 100) / 100,
    })),
    health: health.length ? health : brainP95.map((b) => ({ day: b.day, score: 85 })),
  };
}

export async function getSessionDetailForAnalytics(
  pool: Pool,
  recruiterId: string,
  sessionId: string
) {
  const s = await pool.query(
    `
    SELECT s.id, s.candidate_name, s.status, s.started_at, s.completed_at, j.title AS job_title,
           sts.computed_at,
           sts.brain_latency_p95_ms,
           sts.transcript_latency_p95_ms,
           sts.tts_first_byte_p95_ms,
           sts.probe_count,
           sts.interruption_count,
           sts.total_pause_ms,
           sts.stt_failure_count,
           sts.tts_failure_count,
           sts.livekit_disconnect_count,
           sts.fallback_event_count
    FROM interview_sessions s
    JOIN jobs j ON j.id = s.job_id
    LEFT JOIN session_telemetry_summary sts ON sts.session_id = s.id
    WHERE s.id = $1::uuid AND j.recruiter_id = $2::uuid
    `,
    [sessionId, recruiterId]
  );
  if (s.rows.length === 0) return null;
  const row = s.rows[0];

  const turnAgg = await pool.query(
    `
    SELECT
      COUNT(*)::int AS turns,
      AVG(llm_ms)::float8 AS avg_llm,
      percentile_cont(0.95) WITHIN GROUP (ORDER BY llm_ms)::float8 AS p95_llm
    FROM turn_metrics
    WHERE session_id = $1::uuid
    `,
    [sessionId]
  );

  const ta = turnAgg.rows[0];

  return {
    session: {
      id: row.id,
      candidate_name: row.candidate_name,
      status: row.status,
      job_title: row.job_title,
      started_at: row.started_at,
      completed_at: row.completed_at,
    },
    summary: row.computed_at
      ? {
          brain_latency_p95_ms: row.brain_latency_p95_ms,
          transcript_latency_p95_ms: row.transcript_latency_p95_ms,
          tts_first_byte_p95_ms: row.tts_first_byte_p95_ms,
          probe_count: row.probe_count,
          interruption_count: row.interruption_count,
          total_pause_ms: row.total_pause_ms,
          stt_failure_count: row.stt_failure_count,
          tts_failure_count: row.tts_failure_count,
          livekit_disconnect_count: row.livekit_disconnect_count,
          fallback_event_count: row.fallback_event_count,
        }
      : null,
    turns: {
      turns: Number(ta?.turns) || 0,
      avg_llm: ta?.avg_llm != null ? Number(ta.avg_llm) : null,
      p95_llm: ta?.p95_llm != null ? Number(ta.p95_llm) : null,
    },
  };
}
