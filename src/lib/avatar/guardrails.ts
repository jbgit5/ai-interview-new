import type { Pool, PoolClient } from "pg";

/**
 * Spend + safety guardrails for the realistic avatar (Simli) — company account, billed per minute.
 *
 * Mirrors src/lib/live/guardrails.ts:
 *  - OFF unless SIMLI_ENABLED=true AND a dedicated key + face id are configured.
 *  - A session may only be created for an in-progress interview (checked by the route). If a GPT-Live
 *    voice session is open, the avatar can never outlive it; on the pipeline engine the grant is
 *    capped by SIMLI_MAX_SESSION_SECONDS.
 *  - Limits are enforced server-side from the avatar_sessions ledger; unclosed sessions are budgeted
 *    at their full granted duration. The granted duration is ALSO sent to Simli as maxSessionLength,
 *    so the provider itself stops the session — a cap that doesn't depend on our browser code.
 *  - Any error here denies the avatar (fail closed) → the room shows the static photo and keeps the
 *    normal GPT-Live audio, so the candidate never loses Maya's voice.
 */

export const AVATAR_PRICE_PER_MINUTE_USD = 0.05; // third-party reported — verify on Simli's pricing page

const HARD_MAX_SESSION_SECONDS = 1_800;
const MIN_USEFUL_SESSION_SECONDS = 120;
/** Avatar may run this long past the voice session's own cap (token-mint latency, grace). */
const LIVE_SESSION_GRACE_SECONDS = 30;
/** An open avatar row for the same interview this old is considered abandoned (see reserveAvatarSession). */
const SUPERSEDE_AFTER_SECONDS = 20;

export interface AvatarConfig {
  enabled: boolean;
  apiKey: string | null;
  faceId: string | null;
  maxSessionSeconds: number;
  dailyMaxSeconds: number;
  maxConcurrent: number;
  maxCreatesPerInterview: number;
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

export function getAvatarConfig(): AvatarConfig {
  return {
    enabled: process.env.SIMLI_ENABLED === "true",
    apiKey: process.env.SIMLI_API_KEY?.trim() || null,
    faceId: process.env.SIMLI_FACE_ID?.trim() || null,
    maxSessionSeconds: intEnv("SIMLI_MAX_SESSION_SECONDS", 900, 60, HARD_MAX_SESSION_SECONDS),
    dailyMaxSeconds: intEnv("SIMLI_DAILY_MAX_SECONDS", 1_800, 0, 86_400),
    maxConcurrent: intEnv("SIMLI_MAX_CONCURRENT", 2, 0, 20),
    maxCreatesPerInterview: intEnv("SIMLI_MAX_CREATES_PER_INTERVIEW", 2, 0, 5),
  };
}

/** Server-level master switch: flag on AND the dedicated key + face id present. */
export function isAvatarMasterEnabled(cfg: AvatarConfig = getAvatarConfig()): boolean {
  return cfg.enabled && !!cfg.apiKey && !!cfg.faceId;
}

export type AvatarReserveResult =
  | { ok: true; avatarSessionId: string; maxSeconds: number }
  | {
      ok: false;
      reason:
        | "disabled"
        | "no_live_session"
        | "voice_session_ending"
        | "interview_cap"
        | "concurrency_cap"
        | "daily_budget"
        | "error";
    };

export async function reserveAvatarSession(
  pool: Pool,
  args: { interviewSessionId: string }
): Promise<AvatarReserveResult> {
  const cfg = getAvatarConfig();
  if (!isAvatarMasterEnabled(cfg)) return { ok: false, reason: "disabled" };

  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext('avatar_sessions'))");

    // On the GPT-Live engine the avatar renders Maya's live audio, so it must end with that voice
    // session. On the pipeline engine (default) Maya's voice is ours and there is no voice ledger row;
    // the caller already verified the interview is in progress, and the per-session/daily caps below
    // plus Simli's own maxSessionLength bound the spend.
    const live = await client.query(
      `SELECT GREATEST(0, max_seconds - EXTRACT(EPOCH FROM (now() - created_at))::int) AS remaining
         FROM live_voice_sessions
        WHERE interview_session_id = $1 AND closed_at IS NULL
          AND created_at + make_interval(secs => max_seconds + 60) > now()
        ORDER BY created_at DESC LIMIT 1`,
      [args.interviewSessionId]
    );
    const liveRemaining: number =
      live.rows.length > 0 ? live.rows[0].remaining : cfg.maxSessionSeconds;

    // Same reasoning as the voice ledger: a new avatar attempt for this interview replaces its own
    // abandoned row (a failed attempt, a reload) instead of being blocked by it, and attempts that never
    // produced a real session don't count against the per-interview limit.
    await client.query(
      `UPDATE avatar_sessions
          SET closed_at = now(),
              usage_seconds = LEAST(GREATEST(EXTRACT(EPOCH FROM (now() - created_at))::int, 0), max_seconds + 30),
              close_reason = 'superseded'
        WHERE interview_session_id = $1 AND closed_at IS NULL
          AND created_at < now() - make_interval(secs => ${SUPERSEDE_AFTER_SECONDS})`,
      [args.interviewSessionId]
    );
    const perInterview = await client.query(
      `SELECT COUNT(*)::int AS n FROM avatar_sessions
        WHERE interview_session_id = $1
          AND COALESCE(close_reason, '') NOT IN ('mint_failed', 'no_token', 'unreachable')`,
      [args.interviewSessionId]
    );
    if (perInterview.rows[0].n >= cfg.maxCreatesPerInterview) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "interview_cap" };
    }

    const concurrent = await client.query(
      `SELECT COUNT(*)::int AS n FROM avatar_sessions
        WHERE closed_at IS NULL
          AND created_at + make_interval(secs => max_seconds + 60) > now()`
    );
    if (concurrent.rows[0].n >= cfg.maxConcurrent) {
      await client.query("ROLLBACK");
      return { ok: false, reason: "concurrency_cap" };
    }

    const used = await client.query(
      `SELECT COALESCE(SUM(COALESCE(usage_seconds, max_seconds)), 0)::int AS secs
         FROM avatar_sessions WHERE created_at >= date_trunc('day', now())`
    );
    const remainingBudget = cfg.dailyMaxSeconds - used.rows[0].secs;
    const grant = Math.min(
      cfg.maxSessionSeconds,
      remainingBudget,
      liveRemaining + LIVE_SESSION_GRACE_SECONDS
    );
    if (grant < MIN_USEFUL_SESSION_SECONDS) {
      await client.query("ROLLBACK");
      // Say which limit actually bit, so diagnostics point at the right fix.
      const voiceEnding = liveRemaining + LIVE_SESSION_GRACE_SECONDS < MIN_USEFUL_SESSION_SECONDS;
      return { ok: false, reason: voiceEnding ? "voice_session_ending" : "daily_budget" };
    }

    const ins = await client.query(
      `INSERT INTO avatar_sessions (interview_session_id, max_seconds) VALUES ($1, $2) RETURNING id`,
      [args.interviewSessionId, grant]
    );
    await client.query("COMMIT");
    return { ok: true, avatarSessionId: ins.rows[0].id, maxSeconds: grant };
  } catch (err) {
    try {
      await client?.query("ROLLBACK");
    } catch {
      /* ignore */
    }
    console.error("[avatar] reserve failed (failing closed):", err);
    return { ok: false, reason: "error" };
  } finally {
    client?.release();
  }
}

/** Settle a session. Usage is floored at server wall-clock since creation and capped at grant + 30s. */
export async function closeAvatarSession(
  pool: Pool,
  args: { avatarSessionId: string; interviewSessionId: string; usageSeconds: number; reason: string }
): Promise<boolean> {
  const res = await pool.query(
    `UPDATE avatar_sessions
        SET closed_at = COALESCE(closed_at, now()),
            usage_seconds = COALESCE(usage_seconds,
              LEAST(GREATEST($3::int, EXTRACT(EPOCH FROM (now() - created_at))::int), max_seconds + 30)),
            close_reason = COALESCE(close_reason, $4)
      WHERE id = $1 AND interview_session_id = $2`,
    [
      args.avatarSessionId,
      args.interviewSessionId,
      Math.max(0, Math.round(args.usageSeconds)),
      args.reason.slice(0, 40),
    ]
  );
  return (res.rowCount ?? 0) > 0;
}
