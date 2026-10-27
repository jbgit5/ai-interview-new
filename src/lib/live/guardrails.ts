import type { Pool, PoolClient } from "pg";

/**
 * Spend + safety guardrails for the GPT-Live experiment (company OpenAI account).
 *
 * Design rules:
 *  - Everything is OFF unless the server master switch is on AND the recruiter has
 *    turned on the per-job toggle (or the job is on the optional env override list).
 *  - Uses a DEDICATED key (OPENAI_LIVE_API_KEY) — never falls back to OPENAI_API_KEY,
 *    so the experiment can sit in its own OpenAI project with its own hard budget.
 *  - All limits are enforced server-side from the live_voice_sessions ledger.
 *    Unclosed sessions are budgeted at their FULL granted duration (worst case).
 *  - Any error in this module denies live voice (fail closed) → caller falls back
 *    to the existing Deepgram + TTS pipeline.
 */

export const LIVE_PRICE_PER_MINUTE_USD = 0.05; // voice layer only (OpenAI docs)

/** Absolute ceiling regardless of env, so a typo can't grant an hour-long session. */
const HARD_MAX_SESSION_SECONDS = 1_800;
/** Don't start a session that can't run long enough to be useful. */
const MIN_USEFUL_SESSION_SECONDS = 180;
/** An open ledger row for the same interview this old is considered abandoned (see reserveLiveSession). */
const SUPERSEDE_AFTER_SECONDS = 20;

export interface LiveConfig {
  enabled: boolean;
  apiKey: string | null;
  allowedJobIds: Set<string>;
  maxSessionSeconds: number;
  dailyMaxSeconds: number;
  maxConcurrent: number;
  maxCreatesPerInterview: number;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function getLiveConfig(): LiveConfig {
  return {
    enabled: process.env.LIVE_VOICE_ENABLED === "true",
    apiKey: process.env.OPENAI_LIVE_API_KEY?.trim() || null,
    allowedJobIds: new Set(
      (process.env.LIVE_VOICE_ALLOWED_JOB_IDS ?? "")
        .split(",")
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
    ),
    maxSessionSeconds: intEnv("LIVE_VOICE_MAX_SESSION_SECONDS", 900, 60, HARD_MAX_SESSION_SECONDS),
    dailyMaxSeconds: intEnv("LIVE_VOICE_DAILY_MAX_SECONDS", 3_600, 0, 86_400),
    maxConcurrent: intEnv("LIVE_VOICE_MAX_CONCURRENT", 2, 0, 20),
    maxCreatesPerInterview: intEnv("LIVE_VOICE_MAX_CREATES_PER_INTERVIEW", 2, 0, 5),
  };
}

/** Server-level master switch: flag on AND the dedicated key present. */
export function isLiveMasterEnabled(cfg: LiveConfig = getLiveConfig()): boolean {
  return cfg.enabled && !!cfg.apiKey;
}

/**
 * Cheap, DB-free check: may this job use live voice at all?
 * Requires the server master switch, AND either the recruiter's per-job toggle
 * (jobs.live_voice_enabled) or the optional env override list.
 * The spend limits are enforced separately in reserveLiveSession().
 */
export function isLiveEligible(
  job: { id: string; liveVoiceEnabled: boolean },
  cfg: LiveConfig = getLiveConfig()
): boolean {
  if (!isLiveMasterEnabled(cfg)) return false;
  return job.liveVoiceEnabled || cfg.allowedJobIds.has(job.id.toLowerCase());
}

/**
 * Reads jobs.live_voice_enabled from a joined job row (alias `j`) as a SQL expression.
 * Uses to_jsonb so a database that hasn't run migration 014 yet returns NULL instead of
 * erroring — existing interviews must never break because of this experiment.
 */
export const JOB_LIVE_FLAG_SQL = `COALESCE((to_jsonb(j)->>'live_voice_enabled')::boolean, false)`;

export type ReserveResult =
  | { ok: true; liveSessionId: string; maxSeconds: number }
  | {
      ok: false;
      reason:
        | "disabled"
        | "not_allowed"
        | "interview_cap"
        | "concurrency_cap"
        | "daily_budget"
        | "error";
    };

/**
 * Atomically check every limit and insert a ledger row. Serialised with an advisory
 * lock so two simultaneous candidates can't both squeeze under the same limit.
 */
export async function reserveLiveSession(
  pool: Pool,
  args: { interviewSessionId: string; jobId: string; jobLiveVoiceEnabled: boolean }
): Promise<ReserveResult> {
  const cfg = getLiveConfig();
  if (!isLiveMasterEnabled(cfg)) return { ok: false, reason: "disabled" };
  if (!isLiveEligible({ id: args.jobId, liveVoiceEnabled: args.jobLiveVoiceEnabled }, cfg)) {
    return { ok: false, reason: "not_allowed" };
  }

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('live_voice_sessions'))");

    // A candidate can only be in one room. If THIS interview still has an "open" row older than
    // SUPERSEDE_AFTER_SECONDS (a failed attempt, a closed tab, a reload), the new attempt replaces it —
    // otherwise one network blip locked the candidate out of retrying for max_seconds+60 (we saw
    // "concurrency_cap" 53 s after a failed first attempt). Its usage is still recorded (wall-clock,
    // min 15 s) so the daily budget stays honest. Other interviews' rows are never touched, and very
    // fresh rows (< 20 s) are left alone so a double-click can't orphan a live session.
    await client.query(
      `UPDATE live_voice_sessions
          SET closed_at = now(),
              usage_seconds = LEAST(GREATEST(EXTRACT(EPOCH FROM (now() - created_at))::int, 15), max_seconds + 30),
              close_reason = 'superseded'
        WHERE interview_session_id = $1 AND closed_at IS NULL
          AND created_at < now() - make_interval(secs => ${SUPERSEDE_AFTER_SECONDS})`,
      [args.interviewSessionId]
    );

    // Attempts that never produced a real session (provider rejected / unreachable) don't count
    // against the per-interview limit — only real sessions do.
    const perInterview = await client.query(
      `SELECT COUNT(*)::int AS n FROM live_voice_sessions
        WHERE interview_session_id = $1
          AND COALESCE(close_reason, '') NOT IN ('create_failed', 'no_sdp', 'unreachable')`,
      [args.interviewSessionId]
    );
    if (perInterview.rows[0].n >= cfg.maxCreatesPerInterview) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "interview_cap" };
    }

    // "Open" = not closed and still inside its granted window (+60s grace for close reports).
    const concurrent = await client.query(
      `SELECT COUNT(*)::int AS n FROM live_voice_sessions
        WHERE closed_at IS NULL
          AND created_at + make_interval(secs => max_seconds + 60) > now()`
    );
    if (concurrent.rows[0].n >= cfg.maxConcurrent) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "concurrency_cap" };
    }

    const used = await client.query(
      `SELECT COALESCE(SUM(COALESCE(usage_seconds, max_seconds)), 0)::int AS secs
         FROM live_voice_sessions
        WHERE created_at >= date_trunc('day', now())`
    );
    const remaining = cfg.dailyMaxSeconds - used.rows[0].secs;
    const grant = Math.min(cfg.maxSessionSeconds, remaining);
    if (grant < MIN_USEFUL_SESSION_SECONDS) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "daily_budget" };
    }

    const ins = await client.query(
      `INSERT INTO live_voice_sessions (interview_session_id, max_seconds)
       VALUES ($1, $2) RETURNING id`,
      [args.interviewSessionId, grant]
    );
    await client.query("COMMIT");
    return { ok: true, liveSessionId: ins.rows[0].id, maxSeconds: grant };
  } catch (err) {
    try {
      await client?.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[live-voice] reserve failed (failing closed):", err);
    return { ok: false, reason: "error" };
  } finally {
    client?.release();
  }
}

/**
 * Record the end of a live session. `usageSeconds` is client-reported, so it is
 * floored at the server-observed wall-clock time since creation (a client can't
 * under-report to dodge the daily budget) and capped at the granted window + 30s.
 */
export async function closeLiveSession(
  pool: Pool,
  args: { liveSessionId: string; interviewSessionId: string; usageSeconds: number; reason: string }
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE live_voice_sessions
        SET closed_at = COALESCE(closed_at, now()),
            usage_seconds = COALESCE(usage_seconds,
              LEAST(
                GREATEST($3::int, EXTRACT(EPOCH FROM (now() - created_at))::int),
                max_seconds + 30)),
            close_reason = COALESCE(close_reason, $4)
      WHERE id = $1 AND interview_session_id = $2`,
    [
      args.liveSessionId,
      args.interviewSessionId,
      Math.max(0, Math.round(args.usageSeconds)),
      args.reason.slice(0, 40),
    ]
  );
  return (res.rowCount ?? 0) > 0;
}
