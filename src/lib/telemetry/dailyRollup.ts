import type { Pool } from "pg";

/**
 * Aggregates completed sessions from the given calendar day into telemetry_daily_rollup.
 * Uses UTC date boundaries. Replaces existing rows for that day (idempotent).
 */
export async function runDailyTelemetryRollup(pool: Pool, day: Date): Promise<void> {
  const dayStart = new Date(Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate()));
  const dayEnd = new Date(dayStart);
  dayEnd.setUTCDate(dayEnd.getUTCDate() + 1);

  const dayStr = dayStart.toISOString().slice(0, 10);

  const perJob = await pool.query<{
    job_id: string;
    brain_p95_avg: number;
    n: string;
  }>(
    `SELECT
       s.job_id,
       AVG(sts.brain_latency_p95_ms)::float8 AS brain_p95_avg,
       COUNT(*)::text AS n
     FROM interview_sessions s
     INNER JOIN session_telemetry_summary sts ON sts.session_id = s.id
    WHERE s.status IN ('completed', 'shortlisted', 'rejected')
      AND s.completed_at >= $1 AND s.completed_at < $2
      AND sts.brain_latency_p95_ms IS NOT NULL
    GROUP BY s.job_id`,
    [dayStart, dayEnd]
  );

  const globalRow = await pool.query<{
    brain_p95_avg: number;
    n: string;
  }>(
    `SELECT
       AVG(sts.brain_latency_p95_ms)::float8 AS brain_p95_avg,
       COUNT(*)::text AS n
     FROM interview_sessions s
     INNER JOIN session_telemetry_summary sts ON sts.session_id = s.id
    WHERE s.status IN ('completed', 'shortlisted', 'rejected')
      AND s.completed_at >= $1 AND s.completed_at < $2
      AND sts.brain_latency_p95_ms IS NOT NULL`,
    [dayStart, dayEnd]
  );

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM telemetry_daily_rollup WHERE day = $1::date`, [dayStr]);

    for (const row of perJob.rows) {
      await client.query(
        `INSERT INTO telemetry_daily_rollup (day, job_id, metric_key, metric_value, sample_count)
         VALUES ($1::date, $2::uuid, $3, $4, $5::bigint)`,
        [
          dayStr,
          row.job_id,
          "brain_latency_p95_avg",
          row.brain_p95_avg,
          Number(row.n) || 0,
        ]
      );
    }

    const g = globalRow.rows[0];
    if (g?.brain_p95_avg != null && Number(g.n) > 0) {
      await client.query(
        `INSERT INTO telemetry_daily_rollup (day, job_id, metric_key, metric_value, sample_count)
         VALUES ($1::date, NULL, $2, $3, $4::bigint)`,
        [dayStr, "brain_latency_p95_avg", g.brain_p95_avg, Number(g.n) || 0]
      );
    }

    const sessionCounts = await client.query<{ job_id: string; n: string }>(
      `SELECT s.job_id, COUNT(*)::text AS n
         FROM interview_sessions s
         INNER JOIN session_telemetry_summary sts ON sts.session_id = s.id
        WHERE s.status IN ('completed', 'shortlisted', 'rejected')
          AND s.completed_at >= $1 AND s.completed_at < $2
        GROUP BY s.job_id`,
      [dayStart, dayEnd]
    );

    for (const row of sessionCounts.rows) {
      await client.query(
        `INSERT INTO telemetry_daily_rollup (day, job_id, metric_key, metric_value, sample_count)
         VALUES ($1::date, $2::uuid, $3, $4, $5::bigint)`,
        [dayStr, row.job_id, "sessions_with_telemetry", Number(row.n) || 0, Number(row.n) || 0]
      );
    }

    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
