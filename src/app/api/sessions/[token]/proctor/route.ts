import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  const ALLOWED_EVENT_TYPES = new Set([
    "tab_switch", "window_blur", "window_focus",
    "multi_face", "no_face", "gaze_away",
    "paste_detected", "right_click", "devtools_open",
    "fullscreen_exit", "phone_detected",
  ]);

  try {
    const body = await request.json();
    const { event_type, timestamp_ms, severity, metadata } = body;

    if (!event_type) {
      return NextResponse.json({ error: "event_type required" }, { status: 400 });
    }

    // Silently ignore event types not in the allowed set — prevents DB constraint
    // violations if the schema hasn't been migrated yet.
    if (!ALLOWED_EVENT_TYPES.has(event_type)) {
      return NextResponse.json({ ok: true, ignored: true });
    }

    // Look up session by token
    const sessionResult = await pool.query(
      `SELECT id FROM interview_sessions WHERE token = $1`,
      [params.token]
    );
    if (!sessionResult.rows[0]) {
      return NextResponse.json({ error: "Session not found" }, { status: 404 });
    }
    const sessionId = sessionResult.rows[0].id;

    try {
      await pool.query(
        `INSERT INTO proctoring_events (session_id, event_type, timestamp_ms, severity, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [sessionId, event_type, timestamp_ms ?? 0, severity ?? "low", JSON.stringify(metadata ?? {})]
      );
    } catch (dbErr: unknown) {
      // PostgreSQL error 23514 = check_violation — DB constraint predates this event type.
      // Silently ignore so the interview is never interrupted; apply migration 009 to fix permanently.
      const pgCode = (dbErr as { code?: string })?.code;
      if (pgCode === "23514") {
        return NextResponse.json({ ok: true, ignored: true });
      }
      throw dbErr; // re-throw anything else
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("Proctor event error:", err);
    return NextResponse.json({ error: "Internal error" }, { status: 500 });
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  const sessionResult = await pool.query(
    `SELECT id FROM interview_sessions WHERE token = $1`,
    [params.token]
  );
  if (!sessionResult.rows[0]) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const events = await pool.query(
    `SELECT event_type, timestamp_ms, severity, metadata, created_at
     FROM proctoring_events
     WHERE session_id = $1
     ORDER BY timestamp_ms`,
    [sessionResult.rows[0].id]
  );

  return NextResponse.json(events.rows);
}
