import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import {
  getLiveConfig,
  reserveLiveSession,
  closeLiveSession,
  JOB_LIVE_FLAG_SQL,
} from "@/lib/live/guardrails";
import { buildLiveInstructions } from "@/lib/live/instructions";

// POST /api/live/session
// Body: { token: string (interview session token), sdp: string (browser WebRTC offer) }
// Creates ONE GPT-Live voice session after every spend guardrail passes.
// Returns: { sdp, live_session_id, max_seconds }  — or a non-2xx the client treats as
// "fall back to the Deepgram + TTS pipeline".

const OPENAI_LIVE_URL = "https://api.openai.com/v1/live/sessions";
const CREATE_TIMEOUT_MS = 15_000;
const MAX_SDP_CHARS = 32_000;

const DENY_STATUS: Record<string, number> = {
  disabled: 403,
  not_allowed: 403,
  interview_cap: 429,
  concurrency_cap: 429,
  daily_budget: 429,
  error: 503,
};

export async function POST(req: NextRequest) {
  const cfg = getLiveConfig();
  if (!cfg.enabled || !cfg.apiKey) {
    return NextResponse.json({ error: "live_voice_disabled" }, { status: 403 });
  }

  let body: { token?: unknown; sdp?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const token = typeof body.token === "string" ? body.token : "";
  const sdp = typeof body.sdp === "string" ? body.sdp : "";
  if (!token || !sdp.startsWith("v=0") || sdp.length > MAX_SDP_CHARS) {
    return NextResponse.json({ error: "invalid_request" }, { status: 400 });
  }

  // The candidate token is the credential. Only an in-progress, unexpired interview may start voice.
  const found = await pool.query(
    `SELECT s.id, s.status, s.expires_at, j.id AS job_id, j.title,
            ${JOB_LIVE_FLAG_SQL} AS live_voice_flag
       FROM interview_sessions s
       JOIN jobs j ON j.id = s.job_id
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

  // Ledger reservation = the spend gate. Nothing below runs unless it succeeds.
  const reservation = await reserveLiveSession(pool, {
    interviewSessionId: row.id,
    jobId: row.job_id,
    jobLiveVoiceEnabled: row.live_voice_flag === true,
  });
  if (!reservation.ok) {
    console.warn(`[live-voice] denied session=${row.id} reason=${reservation.reason}`);
    return NextResponse.json(
      { error: `live_voice_${reservation.reason}` },
      { status: DENY_STATUS[reservation.reason] ?? 403 }
    );
  }

  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), CREATE_TIMEOUT_MS);
  try {
    const res = await fetch(OPENAI_LIVE_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          model: "gpt-live-1",
          instructions: buildLiveInstructions({ jobTitle: String(row.title ?? "") }),
          audio: { output: { voice: process.env.LIVE_VOICE_VOICE || "marin" } },
          // Our own /turn route stays the interview brain; Live only handles audio.
          delegation: { type: "client" },
        },
        transport: { type: "webrtc", sdp },
      }),
      signal: abort.signal,
    });

    if (!res.ok) {
      const detail = (await res.text().catch(() => "")).slice(0, 300);
      console.error(`[live-voice] OpenAI create failed status=${res.status} ${detail}`);
      await closeLiveSession(pool, {
        liveSessionId: reservation.liveSessionId,
        interviewSessionId: row.id,
        usageSeconds: 0,
        reason: "create_failed",
      });
      return NextResponse.json({ error: "live_voice_provider_error" }, { status: 502 });
    }

    const data = (await res.json()) as {
      session?: { id?: string };
      transport?: { sdp?: string };
    };
    const answerSdp = data.transport?.sdp;
    if (!answerSdp) {
      await closeLiveSession(pool, {
        liveSessionId: reservation.liveSessionId,
        interviewSessionId: row.id,
        usageSeconds: 0,
        reason: "no_sdp",
      });
      return NextResponse.json({ error: "live_voice_provider_error" }, { status: 502 });
    }

    console.info(
      `[live-voice] created session=${row.id} ledger=${reservation.liveSessionId} max=${reservation.maxSeconds}s`
    );
    return NextResponse.json({
      sdp: answerSdp,
      live_session_id: reservation.liveSessionId,
      max_seconds: reservation.maxSeconds,
    });
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    console.error(
      `[live-voice] create ${timedOut ? "timed out" : "could not reach OpenAI"}:`,
      err instanceof Error ? err.message : err
    );
    if (timedOut) {
      // The request may have reached OpenAI and created a billable session, so the ledger row
      // stays open (budgeted at full duration) rather than being zeroed.
      return NextResponse.json({ error: "live_voice_timeout" }, { status: 504 });
    }
    // Fast failure (DNS / connection refused / network down): no session can have been created.
    // Release the reservation — but still record OpenAI's 15 s minimum charge, to stay conservative.
    // Leaving the row open used to lock the candidate out of retrying (concurrency cap) for 6 minutes
    // after a single network blip, and burn the daily budget.
    await closeLiveSession(pool, {
      liveSessionId: reservation.liveSessionId,
      interviewSessionId: row.id,
      usageSeconds: 15,
      reason: "unreachable",
    });
    return NextResponse.json({ error: "live_voice_unreachable" }, { status: 502 });
  } finally {
    clearTimeout(timer);
  }
}
