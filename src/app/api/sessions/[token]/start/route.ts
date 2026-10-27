import { NextRequest, NextResponse } from "next/server";
import { pool } from "@/lib/db";
import { normalizeInterviewerAvatarId } from "@/lib/interviewerAvatar";
import { isLiveEligible, JOB_LIVE_FLAG_SQL } from "@/lib/live/guardrails";

export async function POST(
  _request: NextRequest,
  { params }: { params: { token: string } }
) {
  const result = await pool.query(
    `SELECT s.id,
            s.job_id,
            s.status,
            s.expires_at,
            s.resume_state,
            r.interviewer_avatar_id,
            ${JOB_LIVE_FLAG_SQL} AS live_voice_flag,
            COALESCE((to_jsonb(r)->>'debug_mode')::boolean, false) AS debug_mode
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
    // GPT-Live pilot: server master switch + the recruiter's per-job toggle.
    // The spend limits themselves are enforced later in /api/live/session.
    live_voice_eligible: isLiveEligible({
      id: String(row.job_id),
      liveVoiceEnabled: row.live_voice_flag === true,
    }),
    // Recruiter's Settings → Debug mode: show developer panels in this room.
    debug_mode: row.debug_mode === true,
    interviewer_avatar_id: normalizeInterviewerAvatarId(
      row.interviewer_avatar_id as string | null
    ),
  });
}
