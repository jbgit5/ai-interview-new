import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { normalizeInterviewerAvatarId } from "@/lib/interviewerAvatar";

export async function POST(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const result = await pool.query(
    `SELECT s.id,
            s.status,
            s.expires_at,
            s.resume_state,
            r.interviewer_avatar_id
       FROM interview_sessions s
       JOIN jobs j ON j.id = s.job_id
       JOIN recruiters r ON r.id = j.recruiter_id
      WHERE s.token = $1`,
    [params.token]
  );

  const row = result.rows[0];

  if (!row) {
    return NextResponse.json({ error: "Session not found" }, { status: 404 });
  }

  if (new Date(row.expires_at) < new Date()) {
    // Mark expired
    await pool.query(
      "UPDATE interview_sessions SET status = 'expired' WHERE id = $1",
      [row.id]
    );
    return NextResponse.json({ error: "Session expired" }, { status: 410 });
  }

  if (row.status === "completed") {
    return NextResponse.json({ error: "Interview already completed" }, { status: 409 });
  }

  // For reconnection: if already in_progress, just return the existing state
  if (row.status !== "in_progress") {
    await pool.query(
      `UPDATE interview_sessions
       SET status = 'in_progress',
           started_at = COALESCE(started_at, now()),
           livekit_room = $2,
           updated_at = now()
       WHERE id = $1`,
      [row.id, params.token] // use token UUID as room name
    );
  }

  return NextResponse.json({
    session_id: row.id,
    livekit_room: params.token,
    resume_state: row.resume_state ?? null,
    interviewer_avatar_id: normalizeInterviewerAvatarId(
      row.interviewer_avatar_id as string | null
    ),
  });
}
