import type { Pool } from "pg";
import { diagnoseSession, type DiagInput, type Diagnosis } from "./diagnoseSession";

/**
 * Loads everything needed to diagnose the given sessions in 5 queries total (not per session),
 * then runs the pure diagnoseSession() on each. Authorisation is the CALLER's job — pass only
 * session ids the signed-in recruiter owns.
 */
export async function loadDiagnoses(
  pool: Pool,
  sessionIds: string[]
): Promise<Map<string, Diagnosis>> {
  const out = new Map<string, Diagnosis>();
  if (sessionIds.length === 0) return out;

  const [sessions, turns, events, proctor, ledger, questions] = await Promise.all([
    pool.query(
      `SELECT id, status, exit_type, started_at, completed_at, integrity_score, job_id
         FROM interview_sessions WHERE id = ANY($1::uuid[])`,
      [sessionIds]
    ),
    pool.query(
      `SELECT session_id, turn_index, role, content, created_at
         FROM transcript_turns WHERE session_id = ANY($1::uuid[])
        ORDER BY created_at`,
      [sessionIds]
    ),
    pool.query(
      `SELECT session_id, occurred_at, source, event_name, turn_index, attrs
         FROM session_telemetry_events
        WHERE session_id = ANY($1::uuid[]) AND event_name <> 'interview.state_change'
        ORDER BY occurred_at`,
      [sessionIds]
    ),
    pool.query(
      `SELECT session_id, event_type, severity, timestamp_ms, created_at
         FROM proctoring_events WHERE session_id = ANY($1::uuid[])
        ORDER BY created_at`,
      [sessionIds]
    ),
    // live_voice_sessions only exists after migration 013 — never let that break diagnostics.
    pool
      .query(
        `SELECT DISTINCT ON (interview_session_id)
                interview_session_id AS session_id, max_seconds, usage_seconds, close_reason
           FROM live_voice_sessions WHERE interview_session_id = ANY($1::uuid[])
          ORDER BY interview_session_id, created_at DESC`,
        [sessionIds]
      )
      .catch(() => ({ rows: [] as Array<Record<string, unknown>> })),
    pool.query(
      `SELECT s.id AS session_id,
              (SELECT COUNT(*)::int FROM questions q
                WHERE (q.job_id = s.job_id AND q.session_id IS NULL) OR q.session_id = s.id) AS n
         FROM interview_sessions s WHERE s.id = ANY($1::uuid[])`,
      [sessionIds]
    ),
  ]);

  const group = <T extends { session_id: string }>(rows: T[]) => {
    const m = new Map<string, T[]>();
    for (const r of rows) {
      const k = r.session_id;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return m;
  };
  const turnsBy = group(turns.rows);
  const eventsBy = group(events.rows);
  const proctorBy = group(proctor.rows);
  const ledgerBy = new Map(
    (ledger.rows as Array<{ session_id: string; max_seconds: number; usage_seconds: number | null; close_reason: string | null }>).map(
      (r) => [r.session_id, r]
    )
  );
  const qBy = new Map((questions.rows as Array<{ session_id: string; n: number }>).map((r) => [r.session_id, r.n]));

  for (const s of sessions.rows) {
    const input: DiagInput = {
      session: {
        status: s.status,
        exit_type: s.exit_type,
        started_at: s.started_at,
        completed_at: s.completed_at,
        integrity_score: s.integrity_score,
      },
      turns: turnsBy.get(s.id) ?? [],
      events: eventsBy.get(s.id) ?? [],
      proctor: proctorBy.get(s.id) ?? [],
      ledger: ledgerBy.get(s.id) ?? null,
      questionCount: qBy.get(s.id) ?? 0,
    };
    out.set(s.id, diagnoseSession(input));
  }
  return out;
}
