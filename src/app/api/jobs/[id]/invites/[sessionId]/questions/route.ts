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

  // The interview must belong to this job (no reading another job's candidate questions).
  const sess = await pool.query(
    `SELECT COALESCE(to_jsonb(s)->>'question_order', 'own_first') AS question_order
       FROM interview_sessions s WHERE s.id = $1 AND s.job_id = $2`,
    [params.sessionId, params.id]
  );
  if (!sess.rows[0]) {
    return NextResponse.json({ error: "Invite not found" }, { status: 404 });
  }
  const order = sess.rows[0].question_order === "common_first" ? "common_first" : "own_first";

  // Return ALL questions this candidate will see, in the order the interview asks them:
  // this candidate's own questions and the job's common questions (session_id IS NULL),
  // own-first or common-first as HR chose when inviting.
  const result = await pool.query(
    `SELECT id, text, category, difficulty, expected_hint, source, order_index,
            CASE WHEN (session_id IS NOT NULL) = ($3 = 'own_first') THEN 0 ELSE 1 END AS sort_group
     FROM questions
     WHERE (session_id = $1)
        OR (job_id = $2 AND session_id IS NULL)
     ORDER BY sort_group, order_index`,
    [params.sessionId, params.id, order]
  );

  return NextResponse.json(result.rows);
}
