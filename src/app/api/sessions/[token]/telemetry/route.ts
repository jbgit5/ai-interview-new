import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { insertTelemetryRows } from "@/lib/telemetry/server";
import type { TelemetryBatchEventIn } from "@/lib/telemetry/types";

const MAX_BATCH = 50;
const EVENT_NAME_RE = /^[a-z][a-z0-9_.]{1,80}$/;

// POST /api/sessions/[token]/telemetry
// Body: { events: TelemetryBatchEventIn[] }
export async function POST(
  req: NextRequest,
  { params }: { params: { token: string } }
) {
  let body: { events?: TelemetryBatchEventIn[] };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  const events = body.events;
  if (!Array.isArray(events) || events.length === 0) {
    return NextResponse.json({ error: "events array required" }, { status: 400 });
  }
  if (events.length > MAX_BATCH) {
    return NextResponse.json(
      { error: `Maximum ${MAX_BATCH} events per batch` },
      { status: 400 }
    );
  }

  const sessionResult = await pool.query(
    `SELECT id FROM interview_sessions WHERE token = $1::uuid`,
    [params.token]
  );
  if (!sessionResult.rows[0]) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  const sessionId: string = sessionResult.rows[0].id;

  const rows = [];
  for (const ev of events) {
    if (!ev.event_name || !EVENT_NAME_RE.test(ev.event_name)) {
      return NextResponse.json({ error: `Invalid event_name: ${ev.event_name}` }, { status: 400 });
    }
    let traceId: string | null = null;
    if (ev.trace_id != null && ev.trace_id !== "") {
      const t = String(ev.trace_id);
      if (
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          t
        )
      ) {
        traceId = t;
      }
    }
    rows.push({
      session_id: sessionId,
      occurred_at: ev.occurred_at ? new Date(ev.occurred_at) : new Date(),
      event_name: ev.event_name,
      event_version: ev.event_version ?? 1,
      source: "client" as const,
      trace_id: traceId,
      turn_index:
        typeof ev.turn_index === "number" && Number.isFinite(ev.turn_index)
          ? Math.floor(ev.turn_index)
          : null,
      attrs: {
        ...(ev.attrs ?? {}),
        ...(ev.interview_state ? { interview_state: ev.interview_state } : {}),
      },
    });
  }

  try {
    await insertTelemetryRows(pool, rows);
  } catch (err) {
    console.error("[telemetry] batch insert failed:", err);
    return NextResponse.json({ error: "Failed to store events" }, { status: 500 });
  }

  return NextResponse.json({ ok: true, inserted: rows.length });
}
