import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { pool } from "@/lib/db";

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string; sessionId: string } }
) {
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Verify recruiter owns this job
  const ownerCheck = await pool.query(
    `SELECT j.id, j.question_mode FROM jobs j
     JOIN recruiters r ON r.id = j.recruiter_id
     WHERE j.id = $1 AND r.better_auth_user_id = $2`,
    [params.id, session.user.id]
  );
  if (!ownerCheck.rows[0]) {
    return NextResponse.json({ error: "Job not found" }, { status: 404 });
  }

  // Return ALL questions this candidate will see:
  //  1. Session-specific (resume-generated) questions
  //  2. Job-level questions (ai_only / mixed / custom_only — session_id IS NULL)
  // Resume questions appear first (they are tailored to the candidate)
  const result = await pool.query(
    `SELECT id, text, category, difficulty, expected_hint, source, order_index,
            CASE WHEN session_id IS NOT NULL THEN 0 ELSE 1 END AS sort_group
     FROM questions
     WHERE (session_id = $1)
        OR (job_id = $2 AND session_id IS NULL)
     ORDER BY sort_group, order_index`,
    [params.sessionId, params.id]
  );

  return NextResponse.json(result.rows);
}
