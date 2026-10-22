import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";

const REJOIN_WINDOW_MS = 10 * 60 * 1000; // 10 minutes

export async function GET(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const result = await pool.query(
    `SELECT id, status, started_at, resume_state
     FROM interview_sessions
     WHERE token = $1`,
    [params.token]
  );

  const row = result.rows[0];

  if (!row) {
    return NextResponse.json({ can_rejoin: false, reason: "not_found" });
  }

  if (row.status !== "in_progress") {
    return NextResponse.json({ can_rejoin: false, reason: row.status });
  }

  const startedAt = row.started_at ? new Date(row.started_at).getTime() : 0;
  const elapsed = Date.now() - startedAt;

  if (elapsed > REJOIN_WINDOW_MS) {
    return NextResponse.json({ can_rejoin: false, reason: "timeout" });
  }

  return NextResponse.json({
    can_rejoin: true,
    session_id: row.id,
    livekit_room: params.token,
    resume_state: row.resume_state ?? null,
  });
}
