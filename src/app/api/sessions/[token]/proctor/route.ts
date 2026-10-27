import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { mkdir, writeFile } from "fs/promises";
import path from "path";
import { pool } from "@/lib/db";

const JPEG_DATA_URL = "data:image/jpeg;base64,";
/** A 320 px camera frame is ~15–40 KB; anything far bigger isn't one of ours. */
const MAX_SNAPSHOT_BYTES = 150_000;
/** Bound disk use per interview even if a client misbehaves. */
const MAX_SNAPSHOTS_PER_SESSION = 60;

/**
 * Save a violation snapshot next to the recordings: recordings/<sessionId>/proctor/<file>.jpg.
 * Strictly best-effort — any problem returns null and the event is still recorded without an image.
 */
async function saveSnapshot(sessionId: string, dataUrl: unknown): Promise<string | null> {
  try {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith(JPEG_DATA_URL)) return null;
    const buf = Buffer.from(dataUrl.slice(JPEG_DATA_URL.length), "base64");
    // Must really be a JPEG (magic bytes FF D8) and a sane size.
    if (buf.length < 100 || buf.length > MAX_SNAPSHOT_BYTES || buf[0] !== 0xff || buf[1] !== 0xd8) return null;
    const count = await pool
      .query(
        `SELECT COUNT(*)::int AS n FROM proctoring_events WHERE session_id = $1 AND snapshot_path IS NOT NULL`,
        [sessionId]
      )
      .catch(() => ({ rows: [{ n: 0 }] }));
    if (count.rows[0].n >= MAX_SNAPSHOTS_PER_SESSION) return null;
    const dir = path.join(process.cwd(), "recordings", sessionId, "proctor");
    await mkdir(dir, { recursive: true });
    const name = `${Date.now()}-${randomUUID()}.jpg`;
    await writeFile(path.join(dir, name), buf);
    return `${sessionId}/proctor/${name}`;
  } catch (err) {
    console.error("[proctor] snapshot save failed (event still recorded):", err);
    return null;
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: { token: string } }
) {
  const ALLOWED_EVENT_TYPES = new Set([
    "tab_switch", "window_blur", "window_focus",
    "multi_face", "no_face", "gaze_away",
    "paste_detected", "right_click", "devtools_open",
    "fullscreen_exit", "phone_detected", "multiple_monitors",
  ]);

  try {
    const body = await request.json();
    const { event_type, timestamp_ms, severity, metadata, snapshot } = body;

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
    const snapshotPath = await saveSnapshot(sessionId, snapshot);
    const values = [sessionId, event_type, timestamp_ms ?? 0, severity ?? "low", JSON.stringify(metadata ?? {})];

    try {
      await pool.query(
        `INSERT INTO proctoring_events (session_id, event_type, timestamp_ms, severity, metadata, snapshot_path)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [...values, snapshotPath]
      );
    } catch (dbErr: unknown) {
      const pgCode = (dbErr as { code?: string })?.code;
      // 23514 = check_violation — DB constraint predates this event type. Ignore so the interview
      // is never interrupted; apply migration 009 to fix permanently.
      if (pgCode === "23514") {
        return NextResponse.json({ ok: true, ignored: true });
      }
      // 42703 = undefined_column — migration 017 (snapshot_path) not applied yet: record without it.
      if (pgCode === "42703") {
        await pool.query(
          `INSERT INTO proctoring_events (session_id, event_type, timestamp_ms, severity, metadata)
           VALUES ($1, $2, $3, $4, $5)`,
          values
        );
        return NextResponse.json({ ok: true, snapshot: false });
      }
      throw dbErr; // re-throw anything else
    }

    return NextResponse.json({ ok: true, snapshot: !!snapshotPath });
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
