import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import {
  getAvatarConfig,
  isAvatarMasterEnabled,
  reserveAvatarSession,
  closeAvatarSession,
} from "@/lib/avatar/guardrails";

// POST /api/avatar/simli/session
// Body: { token: string (interview session token) }
// Mints ONE Simli session token (after every spend guardrail passes). The Simli API key never leaves
// the server; the browser only receives a short-lived session token that Simli itself limits to
// `maxSessionLength` seconds. Any non-2xx means "show the static photo and keep Maya's normal audio".

const SIMLI_TOKEN_URL = "https://api.simli.ai/compose/token";
const MINT_TIMEOUT_MS = 10_000;
/** No audio for this long → Simli ends the session (we stream continuously, so this is a safety net). */
const MAX_IDLE_SECONDS = 180;

const DENY_STATUS: Record<string, number> = {
  disabled: 403,
  no_live_session: 409,
  voice_session_ending: 409,
  interview_cap: 429,
  concurrency_cap: 429,
  daily_budget: 429,
  error: 503,
};

export async function POST(req: NextRequest) {
  const cfg = getAvatarConfig();
  if (!isAvatarMasterEnabled(cfg)) {
    return NextResponse.json({ error: "avatar_disabled" }, { status: 403 });
  }

  let body: { token?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  if (!token) return NextResponse.json({ error: "invalid_request" }, { status: 400 });

  // The candidate token is the credential. Only an in-progress, unexpired interview whose recruiter
  // actually chose the real-person avatar may spend avatar minutes.
  const found = await pool.query(
    `SELECT s.id, s.status, s.expires_at, r.interviewer_avatar_id
       FROM interview_sessions s
       JOIN jobs j ON j.id = s.job_id
       JOIN recruiters r ON r.id = j.recruiter_id
      WHERE s.token = $1`,
    [token]
  );
  const row = found.rows[0];
  if (!row) return NextResponse.json({ error: "session_not_found" }, { status: 404 });
  if (new Date(row.expires_at) < new Date()) {
    return NextResponse.json({ error: "session_expired" }, { status: 410 });
  }
  if (row.status !== "in_progress") {
    return NextResponse.json({ error: "session_not_in_progress" }, { status: 409 });
  }
  if (row.interviewer_avatar_id !== "real") {
    return NextResponse.json({ error: "avatar_not_selected" }, { status: 403 });
  }

  const reservation = await reserveAvatarSession(pool, { interviewSessionId: row.id });
  if (!reservation.ok) {
    console.warn(`[avatar] denied session=${row.id} reason=${reservation.reason}`);
    return NextResponse.json(
      { error: `avatar_${reservation.reason}` },
      { status: DENY_STATUS[reservation.reason] ?? 403 }
    );
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), MINT_TIMEOUT_MS);
  try {
    const res = await fetch(SIMLI_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-simli-api-key": cfg.apiKey as string },
      body: JSON.stringify({
        faceId: cfg.faceId,
        // false because the browser streams Maya's live audio track continuously (per Simli docs
        // for listenToMediastreamTrack).
        handleSilence: false,
        // The real cap: Simli ends the session itself after this many seconds.
        maxSessionLength: reservation.maxSeconds,
        maxIdleTime: MAX_IDLE_SECONDS,
      }),
      signal: abort.signal,
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 200);
      console.error(`[avatar] Simli token mint failed status=${res.status} ${detail}`);
      // No token was issued, so nothing was consumed — release the reservation.
      await closeAvatarSession(pool, {
        avatarSessionId: reservation.avatarSessionId,
        interviewSessionId: row.id,
        usageSeconds: 0,
        reason: "mint_failed",
      });
      return NextResponse.json({ error: "avatar_provider_error" }, { status: 502 });
    }

    const data = (await res.json()) as { session_token?: string };
    if (!data.session_token) {
      await closeAvatarSession(pool, {
        avatarSessionId: reservation.avatarSessionId,
        interviewSessionId: row.id,
        usageSeconds: 0,
        reason: "no_token",
      });
      return NextResponse.json({ error: "avatar_provider_error" }, { status: 502 });
    }

    console.info(
      `[avatar] token minted session=${row.id} ledger=${reservation.avatarSessionId} max=${reservation.maxSeconds}s`
    );
    return NextResponse.json({
      session_token: data.session_token,
      avatar_session_id: reservation.avatarSessionId,
      max_seconds: reservation.maxSeconds,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    console.error(
      `[avatar] token mint ${timedOut ? "timed out" : "could not reach Simli"}:`,
      err instanceof Error ? err.message : err
    );
    if (timedOut) {
      // On a timeout a token may still have been issued, so the row is left open (budgeted in full).
      return NextResponse.json({ error: "avatar_timeout" }, { status: 504 });
    }
    // Fast failure (network down): no token was issued — release the reservation so a retry isn't blocked.
    await closeAvatarSession(pool, {
      avatarSessionId: reservation.avatarSessionId,
      interviewSessionId: row.id,
      usageSeconds: 0,
      reason: "unreachable",
    });
    return NextResponse.json({ error: "avatar_unreachable" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
