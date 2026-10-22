import type { Pool, PoolClient } from "pg";

/**
 * Computes session_telemetry_summary from turn_metrics + session_telemetry_events.
 * Idempotent upsert — safe to call multiple times.
 */
export async function computeAndUpsertSessionSummary(
  db: Pool | PoolClient,
  sessionId: string
): Promise<void> {
  const tm = await db.query(
    `SELECT
       COUNT(*)::int AS turn_count,
       COALESCE(percentile_cont(0.95) WITHIN GROUP (ORDER BY llm_ms), 0)::int AS brain_p95,
       COUNT(*) FILTER (WHERE action = 'probe')::int AS probe_count
     FROM turn_metrics
    WHERE session_id = $1`,
    [sessionId]
  );

  const ev = await db.query(
    `SELECT
       COUNT(*) FILTER (WHERE event_name IN ('stt.error','stt.fallback','stt.deepgram.error'))::int AS stt_fail,
       COUNT(*) FILTER (WHERE event_name = 'tts.error')::int AS tts_fail,
       COUNT(*) FILTER (WHERE event_name = 'livekit.room.disconnected')::int AS lk_dc,
       COUNT(*) FILTER (WHERE event_name = 'interview.eot.fallback_used')::int AS fb,
       COUNT(*) FILTER (WHERE event_name = 'interview.vad.interruption')::int AS intr,
       COALESCE(SUM((attrs->>'pause_duration_ms')::bigint), 0)::bigint AS pause_sum,
       COALESCE(percentile_cont(0.95) WITHIN GROUP (
         ORDER BY NULLIF((attrs->>'tts_fetch_ms')::numeric, NULL)
       ), 0)::int AS tts_p95
     FROM session_telemetry_events
    WHERE session_id = $1`,
    [sessionId]
  );

  const transcript = await db.query(
    `SELECT
       COALESCE(percentile_cont(0.95) WITHIN GROUP (
         ORDER BY NULLIF((attrs->>'stt_final_latency_ms')::numeric, NULL)
       ), 0)::int AS tx_p95
     FROM session_telemetry_events
    WHERE session_id = $1
      AND event_name = 'stt.final_latency'`,
    [sessionId]
  );

  const rowTm = tm.rows[0] ?? {};
  const rowEv = ev.rows[0] ?? {};
  const rowTx = transcript.rows[0] ?? {};

  await db.query(
    `INSERT INTO session_telemetry_summary
       (session_id, computed_at,
        transcript_latency_p95_ms, brain_latency_p95_ms, tts_first_byte_p95_ms,
        eot_accuracy_rate, probe_count, interruption_count, total_pause_ms,
        stt_failure_count, tts_failure_count, livekit_disconnect_count, fallback_event_count,
        attrs)
     VALUES ($1, now(), $2, $3, $4, NULL, $5, $6, $7, $8, $9, $10, $11,
             $12::jsonb)
     ON CONFLICT (session_id) DO UPDATE SET
       computed_at                  = EXCLUDED.computed_at,
       transcript_latency_p95_ms    = EXCLUDED.transcript_latency_p95_ms,
       brain_latency_p95_ms         = EXCLUDED.brain_latency_p95_ms,
       tts_first_byte_p95_ms        = EXCLUDED.tts_first_byte_p95_ms,
       probe_count                  = EXCLUDED.probe_count,
       interruption_count           = EXCLUDED.interruption_count,
       total_pause_ms               = EXCLUDED.total_pause_ms,
       stt_failure_count            = EXCLUDED.stt_failure_count,
       tts_failure_count            = EXCLUDED.tts_failure_count,
       livekit_disconnect_count     = EXCLUDED.livekit_disconnect_count,
       fallback_event_count         = EXCLUDED.fallback_event_count,
       attrs                        = EXCLUDED.attrs`,
    [
      sessionId,
      Number(rowTx.tx_p95) || null,
      Number(rowTm.brain_p95) || null,
      Number(rowEv.tts_p95) || null,
      Number(rowTm.probe_count) || 0,
      Number(rowEv.intr) || 0,
      Number(rowEv.pause_sum) || 0,
      Number(rowEv.stt_fail) || 0,
      Number(rowEv.tts_fail) || 0,
      Number(rowEv.lk_dc) || 0,
      Number(rowEv.fb) || 0,
      JSON.stringify({ turn_metrics_turns: Number(rowTm.turn_count) || 0 }),
    ]
  );
}
